function print(...args) {
  console.log(...args);
}
function readbuffer(filename) {
  const fs = require("fs");
  return fs.readFileSync(filename);
}
class ProcExit {
  constructor(code) {
    this.code = code;
    this.msg = `process exited with code ${code}.`;
  }
  toString() {
    return this.msg;
  }
}

class NotImplemented extends Error {
  constructor(modname, fieldname) {
    super(`${modname}.${fieldname} not implemented.`);
  }
}

class AbortError extends Error {
  constructor(msg = "abort") {
    super(msg);
  }
}

class AssertError extends Error {
  constructor(msg) {
    super(msg);
  }
}

function assert(cond) {
  if (!cond) {
    throw new AssertError("assertion failed.");
  }
}

function profile(name, f) {
  const start = performance.now();
  try {
    return f();
  } catch (exn) {
    throw exn;
  } finally {
    const time = performance.now() - start;
    print(`|| ${name} took ${time.toFixed(2)}ms`);
  }
}

function readFile(filename) {
  return profile(`readFile(${filename})`, () => readbuffer(filename));
}

function getModuleFromBuffer(buffer) {
  return profile(`new Module`, () => new WebAssembly.Module(buffer));
}

function getModuleFromFile(filename) {
  return getModuleFromBuffer(readFile(filename));
}

function getInstance(module, imports) {
  return profile(
    `new Instance`,
    () => new WebAssembly.Instance(module, imports)
  );
}

function getImportObject(obj, names) {
  const result = {};
  for (let name of names) {
    result[name] = obj[name].bind(obj);
  }
  return result;
}

function readStr(u8, o, len = -1) {
  let str = "";
  let end = u8.length;
  if (len != -1) end = o + len;
  for (let i = o; i < end && u8[i] != 0; ++i) str += String.fromCharCode(u8[i]);
  return str;
}

const ESUCCESS = 0;

class Memory {
  constructor(memory) {
    this.memory = memory;
    this.buffer = this.memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }

  check() {
    if (this.buffer.byteLength === 0) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }
  }

  read8(o) {
    return this.u8[o];
  }
  read32(o) {
    return this.u32[o >> 2];
  }
  write8(o, v) {
    this.u8[o] = v;
  }
  write32(o, v) {
    this.u32[o >> 2] = v;
  }
  write64(o, vlo, vhi = 0) {
    this.write32(o, vlo);
    this.write32(o + 4, vhi);
  }

  readStr(o, len) {
    return readStr(this.u8, o, len);
  }

  // Null-terminated string.
  writeStr(o, str) {
    o += this.write(o, str);
    this.write8(o, 0);
    return str.length + 1;
  }

  write(o, buf) {
    if (buf instanceof ArrayBuffer) {
      return this.write(o, new Uint8Array(buf));
    } else if (typeof buf === "string") {
      return this.write(
        o,
        buf.split("").map((x) => x.charCodeAt(0))
      );
    } else {
      const dst = new Uint8Array(this.buffer, o, buf.length);
      dst.set(buf);
      return buf.length;
    }
  }
}

class HostWriteBuffer {
  constructor() {
    this.buffer = "";
  }

  write(str) {
    this.buffer += str;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        break;
      }
      print(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
  }

  flush() {
    if (this.buffer.length > 0) {
      print(this.buffer);
    }
  }
}

class MemFS {
  constructor() {
    this.hostWriteBuffer = new HostWriteBuffer();
    this.hostMem_ = null; // Set later when wired up to application.

    // Imports for memfs module.
    const env = getImportObject(this, [
      "abort",
      "host_write",
      "memfs_log",
      "copy_in",
      "copy_out",
    ]);

    this.instance = getInstance(getModuleFromFile("memfs"), { env });
    this.exports = this.instance.exports;

    this.mem = new Memory(this.exports.memory);

    profile("init memfs", () => this.exports.init());
  }

  set hostMem(mem) {
    this.hostMem_ = mem;
  }

  addDirectory(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    this.exports.AddDirectoryNode(path.length);
  }

  addFile(path, contents) {
    const length =
      contents instanceof ArrayBuffer ? contents.byteLength : contents.length;
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.AddFileNode(path.length, length);
    const addr = this.exports.GetFileNodeAddress(inode);
    this.mem.check();
    this.mem.write(addr, contents);
  }

  getFileContents(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.FindNode(path.length);
    const addr = this.exports.GetFileNodeAddress(inode);
    const size = this.exports.GetFileNodeSize(inode);
    return new Uint8Array(this.mem.buffer, addr, size);
  }

  hostFlush() {
    this.hostWriteBuffer.flush();
  }

  abort() {
    throw new AbortError();
  }

  host_write(fd, iovs, iovs_len, nwritten_out) {
    this.hostMem_.check();
    assert(fd <= 2);
    let size = 0;
    let str = "";
    for (let i = 0; i < iovs_len; ++i) {
      const buf = this.hostMem_.read32(iovs);
      iovs += 4;
      const len = this.hostMem_.read32(iovs);
      iovs += 4;
      str += this.hostMem_.readStr(buf, len);
      size += len;
    }
    this.hostMem_.write32(nwritten_out, size);
    this.hostWriteBuffer.write(str);
    return ESUCCESS;
  }

  memfs_log(buf, len) {
    this.mem.check();
    print(this.mem.readStr(buf, len));
  }

  copy_out(clang_dst, memfs_src, size) {
    this.hostMem_.check();
    const dst = new Uint8Array(this.hostMem_.buffer, clang_dst, size);
    this.mem.check();
    const src = new Uint8Array(this.mem.buffer, memfs_src, size);
    print(
      `>>>>>>>copy_out(${clang_dst.toString(16)}, ${memfs_src.toString(
        16
      )}, ${size})`
    );

    dst.set(src);
    var str = String.fromCharCode.apply(null, dst);
    print("[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[", str);
  }

  copy_in(memfs_dst, clang_src, size) {
    this.mem.check();
    const dst = new Uint8Array(this.mem.buffer, memfs_dst, size);
    this.hostMem_.check();
    const src = new Uint8Array(this.hostMem_.buffer, clang_src, size);
    // print(`copy_in(${memfs_dst.toString(16)}, ${clang_src.toString(16)}, ${size})`);
    dst.set(src);
  }
}

class App {
  constructor(module, memfs, name, ...args) {
    this.argv = [name, ...args];
    this.environ = { USER: "alice" };
    this.memfs = memfs;

    const wasi_unstable = getImportObject(this, [
      "proc_exit",
      "environ_sizes_get",
      "environ_get",
      "args_sizes_get",
      "args_get",
      "random_get",
      "clock_time_get",
      "poll_oneoff",
    ]);

    // Fill in some WASI implementations from memfs.
    Object.assign(wasi_unstable, this.memfs.exports);

    this.instance = getInstance(module, {
      wasi_snapshot_preview1: wasi_unstable,
    });
    this.exports = this.instance.exports;
    this.mem = new Memory(this.exports.memory);
    this.memfs.hostMem = this.mem;

    try {
      profile(`running ${name}`, () => this.exports._start());
    } catch (exn) {
      if (!(exn instanceof ProcExit) || exn.code != 0) {
        throw exn;
      }
    }
  }

  proc_exit(code) {
    throw new ProcExit(code);
  }

  environ_sizes_get(environ_count_out, environ_buf_size_out) {
    this.mem.check();
    let size = 0;
    const names = Object.getOwnPropertyNames(this.environ);
    for (const name of names) {
      const value = this.environ[name];
      // +2 to account for = and \0 in "name=value\0".
      size += name.length + value.length + 2;
    }
    this.mem.write64(environ_count_out, names.length);
    this.mem.write64(environ_buf_size_out, size);
    return ESUCCESS;
  }

  environ_get(environ_ptrs, environ_buf) {
    this.mem.check();
    const names = Object.getOwnPropertyNames(this.environ);
    for (const name of names) {
      this.mem.write32(environ_ptrs, environ_buf);
      environ_ptrs += 4;
      environ_buf += this.mem.writeStr(
        environ_buf,
        `${name}=${this.environ[name]}`
      );
    }
    this.mem.write32(environ_ptrs, 0);
    return ESUCCESS;
  }

  args_sizes_get(argc_out, argv_buf_size_out) {
    this.mem.check();
    let size = 0;
    for (let arg of this.argv) {
      size += arg.length + 1; // "arg\0".
    }
    this.mem.write64(argc_out, this.argv.length);
    this.mem.write64(argv_buf_size_out, size);
    return ESUCCESS;
  }

  args_get(argv_ptrs, argv_buf) {
    this.mem.check();
    for (let arg of this.argv) {
      this.mem.write32(argv_ptrs, argv_buf);
      argv_ptrs += 4;
      argv_buf += this.mem.writeStr(argv_buf, arg);
    }
    this.mem.write32(argv_ptrs, 0);
    return ESUCCESS;
  }

  random_get(buf, buf_len) {
    const data = new Uint8Array(this.mem.buffer, buf, buf_len);
    for (let i = 0; i < buf_len; ++i) {
      data[i] = (Math.random() * 256) | 0;
    }
  }

  clock_time_get(clock_id, precision, time_out) {
    throw new NotImplemented("wasi_unstable", "clock_time_get");
  }

  poll_oneoff(in_ptr, out_ptr, nsubscriptions, nevents_out) {
    throw new NotImplemented("wasi_unstable", "poll_oneoff");
  }
}

class Tar {
  constructor(filename) {
    this.u8 = new Uint8Array(readbuffer(filename));
    this.offset = 0;
  }

  readStr(len) {
    const result = readStr(this.u8, this.offset, len);
    this.offset += len;
    return result;
  }

  readOctal(len) {
    return parseInt(this.readStr(len), 8);
  }

  alignUp() {
    this.offset = (this.offset + 511) & ~511;
  }

  readEntry() {
    if (this.offset + 512 > this.u8.length) {
      return null;
    }

    const entry = {
      filename: this.readStr(100),
      mode: this.readOctal(8),
      owner: this.readOctal(8),
      group: this.readOctal(8),
      size: this.readOctal(12),
      mtim: this.readOctal(12),
      checksum: this.readOctal(8),
      type: this.readStr(1),
      linkname: this.readStr(100),
    };

    if (this.readStr(8) !== "ustar  ") {
      return null;
    }

    entry.ownerName = this.readStr(32);
    entry.groupName = this.readStr(32);
    entry.devMajor = this.readStr(8);
    entry.devMinor = this.readStr(8);
    entry.filenamePrefix = this.readStr(155);
    this.alignUp();

    if (entry.type === "0") {
      // Regular file.
      entry.contents = this.u8.subarray(this.offset, this.offset + entry.size);
      this.offset += entry.size;
      this.alignUp();
    } else if (entry.type !== "5") {
      // Directory.
      print("type", entry.type);
      assert(false);
    }
    return entry;
  }
}

function isPrint(b) {
  return b >= 32 && b < 128;
}

function dump(buf) {
  let str = "";
  let addr = 0;
  let line = buf.slice(addr, addr + 16);
  while (line.length > 0) {
    let lineStr = `${addr.toString(16).padStart(8, "0")}:`;

    for (let i = 0; i < line.length; i += 2) {
      lineStr += ` ${line[i].toString(16).padStart(2, "0")}`;
      if (i + 1 < line.length) {
        lineStr += `${line[i + 1].toString(16).padStart(2, "0")}`;
      }
    }
    lineStr = lineStr.padEnd(51, " ");
    for (let i = 0; i < line.length; ++i) {
      let b = line[i];
      let c = isPrint(b) ? String.fromCharCode(b) : ".";
      lineStr += `${c}`;
    }
    lineStr += "\n";

    addr += 16;
    line = buf.slice(addr, addr + 16);
    str += lineStr;
  }
  print(str);
}

profile("total time", () => {
  const input = "test.cc";
  const contents = `
      #include "type_traits"  
      
      `;

  const memfs = new MemFS();
  memfs.addFile(input, contents);
  memfs.addFile("type_traits", readbuffer("type_traits"));
  memfs.addFile("functional", readbuffer("functional"));

  //   profile("untar", () => {
  //     const tar = new Tar("sysroot.tar");
  //     let entry;
  //     while ((entry = tar.readEntry())) {
  //       switch (entry.type) {
  //         case "0": // Regular file.
  //           memfs.addFile(entry.filename, entry.contents);
  //           break;
  //         case "5":
  //           memfs.addDirectory(entry.filename);
  //           break;
  //       }
  //     }
  //   });

  const clang = getModuleFromFile("clang");
  // const lld = getModuleFromFile('lld');

  const wasm = "test";

  profile("compile+link", () => {
    const libdir = "lib/wasm32-wasi";
    const crt1 = `${libdir}/crt1.o`;
    const obj = "test.o";

    new App(
      clang,
      memfs,
      "clang",
      "-cc1",
      // '-triple', 'wasm32-unknown-wasi',
      "-emit-obj",
      // '-E',
      // '-S',
      // '-main-file-name', input, '-mrelocation-model', 'static',
      // '-mthread-model', 'single', '-mconstructor-aliases',
      // '-fuse-init-array', '-target-cpu', 'generic', '-fvisibility',
      // 'hidden', '-momit-leaf-frame-pointer', '-resource-dir',
      // '/lib/clang/8.0.1',
      //   "-isysroot",
      //   "/",
      //   "-internal-isystem",
      //   "/include/c++/v1",
      //   "-internal-isystem",
      //   "/include",
      //   "-internal-isystem",
      //   "/lib/clang/12.0.1/include",

      // '-fdebug-compilation-dir', '/',
      // '-O2',
      "-ferror-limit",
      "19",
      "-fmessage-length=50",
      "-fno-common",
      "-o",
      obj,
      "-x",
      "c++",
      "type_traits"
    );

    if (false) {
      new App(
        lld,
        memfs,
        "wasm-ld",
        "--no-threads",
        `-L${libdir}`,
        crt1,
        obj,
        "-lc",
        "-o",
        wasm
      );
    }
  });

  if (false) {
    const test = getModuleFromBuffer(memfs.getFileContents(wasm));
    new App(test, memfs, "test");
  }

  memfs.hostFlush();
});
