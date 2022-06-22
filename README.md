# 在浏览器中运行clang和llc

# 介绍

[Webassembly](https://webassembly.org/) (wasm)是一种栈式虚拟机的指令集。目前，wasm 1.0版本已经被多个主流的浏览器支持。llvm 从8.0开始支持wasm的代码生成（codegen）：可以将c家族的代码编译、链接为wasm字节码，并在实现了wasm指令集的浏览器或相关的虚拟机上运行。

**[W**eb**A**ssembly **S**ystem **I**nterface (wasi)](https://wasi.dev/) 是一套基于沙箱机制的系统接口。[Lin Clark](https://twitter.com/linclark) 的[相关博客](https://hacks.mozilla.org/2019/03/standardizing-wasi-a-webassembly-system-interface/)对此做了详细的介绍。笼统地说，wasi允许将常用的系统接口（比如pread, seek）作为extern symbols 暴露出来，具体实现交给wasm虚拟机外部程序，由虚拟机的实现者负责调配。这即保证了接口的规范，同时兼顾了安全性。以node.js为例，

```jsx
const wasm_module = new WebAssembly.Instance(wasm_file_buffer,
{wasi_snapshot_preview1：imports});
```

上述代码中的imports就是wasm_file_buffer字节码实际使用的系统接口的外部实现。

https://github.com/WebAssembly/wasi-libc 实现了部分POSIX c接口，包括标准输入输出，文件输出，内存管理等等。利用wasi-libc，我们可以将[llvm-libcxx](https://libcxx.llvm.org/) 编译为wasm版本。值得注意的是，llvm-libcxx没有实现thread。为了规范性，[Ben Smith](https://github.com/binji) 做了一个[假的thread模块](https://github.com/binji/wasi-sdk/commit/b6e735e9968ddfecfdc49bc72ba5aed7bb83c600)，我们借鉴了他的方法。 

只要存在libc和libcxx，原则上我们可以编译出llvm相关工具链。只需要做一些小的修改：屏蔽掉wasi不支持的系统接口，例如[Unix.inc](https://github.com/TuringKi/llvm-project-12-wasi/blob/master/llvm/lib/Support/Unix/Unix.h)， [Path.inc](https://github.com/TuringKi/llvm-project-12-wasi/blob/master/llvm/lib/Support/Unix/Path.inc)源码中的部分实现。

编译出wasm版本的clang,llc,lld之后，我们还需要实现一个虚拟的文件系统，来支持这些编译工具链的调用。我们直接使用了Ben Smith的memfs [实现](https://github.com/binji/llvm-project/tree/master/binji) 。只是做了少量修改，让它适应当前版本的wasi-libc。memfs的实现较为简单，它将所有内存的分配都委托给JavaScript，通过地址的传递来与JavaScript互动。

# 从源码编译

我们提供了[预编译版本](https://github.com/TuringKi/llvm-project-12-wasi/releases/tag/v0.0.1)， 下载后，拷贝到binji目录，可以直接node test.js运行。

如果你需要从源码编译，应该首先编译支持wasm代码生成的llvm工具链、wasi-libc和llvm-libcxx。

https://github.com/WebAssembly/wasi-sdk 提供了完整的支持。你可以参考它的文档。

**注意**：*由于wasi并不支持thread，你需要做一个假的放进去，可以参考这个https://github.com/binji/wasi-sdk/commit/b6e735e9968ddfecfdc49bc72ba5aed7bb83c600。*

编译出wasi-sdk后，你还需要llvm 12版本的本地clang-tblgen和llvm-tblgen，用来将.td文件中的定义转译为c++源文件。它们的编译可以参考llvm生成的官方文档。

**注意**：*你不能在本工程生成clang-tblgen和llvm-tblgen，因为Support/Unix 下的文件是修改过的，它无法在本地编译通过。*

完成上述步骤后，在本工程的根目录执行如下的构建命令：

```bash
WASI_SDK_PATH="【你的wasi-sdk路径】" \
CC="${WASI_SDK_PATH}/bin//clang --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot" \
CXX="${WASI_SDK_PATH}/bin//clang++ --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot" \
cmake -GNinja -Bbuild-wasm \
-DCMAKE_CXX_FLAGS="-D_WASI_EMULATED_SIGNAL -D__LLVM_CUSTOM_WASI__" \
	-DCMAKE_INSTALL_PREFIX=`pwd`/build-wasm/install/ \
  -DLLVM_ENABLE_PROJECTS="clang;lld;clang-tools-extra" \
   -DMLIR_ENABLE_BINDINGS_PYTHON=ON \
  -DLLVM_TARGETS_TO_BUILD="WebAssembly;NVPTX;X86;RISCV;AMDGPU" \
  -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
-DCMAKE_C_COMPILER_LAUNCHER=ccache \
-DCMAKE_CXX_COMPILER_LAUNCHER=ccache \
-DCMAKE_BUILD_TYPE=Release \
-DLLVM_BUILD_EXAMPLES=OFF \
-DLLVM_TABLEGEN=$PWD/build-host/bin/llvm-tblgen \
-DCLANG_TABLEGEN=$PWD/build-host/bin/clang-tblgen \
  ./llvm
```
