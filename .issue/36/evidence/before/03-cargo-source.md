# before — 빌드가 crates.io 의 tao 를 쓰는 상태

$ cargo tree -p tao --depth 0
tao v0.35.3

$ grep -A3 name=\"tao\" Cargo.lock
name = "tao"
version = "0.35.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d1c93047acf68669466a34690ac58cca7010bd1b201e1ec86f1fd0a75d3dd4a9"

$ grep -n "patch.crates-io" Cargo.toml
(없음 — 패치 미적용)
