sdk = /data1/mx/source2/learning_wasm/test_wasi/wasi-sdk/build/install/opt/wasi-sdk/
clang = ${sdk}/bin/clang
ld = ${sdk}/bin/wasm-ld
sysroot = ${sdk}/share/wasi-sysroot

memfs: memfs.o stb_sprintf.o
	${ld} -L${sysroot}/lib/wasm32-wasi --no-entry --export-dynamic --allow-undefined -o $@ $^ -lc

memfs.o: memfs.c
	${clang} --sysroot=${sysroot} -O2 -Wall -Wextra -Wno-unused-parameter -c -o $@ $<

stb_sprintf.o: stb_sprintf.h
	${clang} --sysroot=${sysroot} -DSTB_SPRINTF_IMPLEMENTATION -x c -O0 -c -o $@ $<