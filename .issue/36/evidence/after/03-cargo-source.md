# after — 빌드가 패치한 vendor/tao 를 쓴다

```
$ cargo tree -p tao --depth 0
tao v0.35.3 (D:\...\vendor\tao)          ← 레지스트리가 아니라 벤더 경로

$ git diff Cargo.lock   (tao 항목)
 name = "tao"
 version = "0.35.3"
-source = "registry+https://github.com/rust-lang/crates.io-index"
-checksum = "d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9"
 dependencies = [
  "bitflags 2.11.0",
  "block2",
  "core-foundation",
  "core-graphics",
  "crossbeam-channel",

$ cargo test --workspace
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 66 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.69s
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 5 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.55s
(합계 82 passed / 0 failed / 2 ignored, 경고 0)
```
