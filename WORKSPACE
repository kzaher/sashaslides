workspace(name = "sashaslides")

load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")

# ============================================================================
# Rules Python
# ============================================================================
http_archive(
    name = "rules_python",
    strip_prefix = "rules_python-0.27.1",
    url = "https://github.com/bazelbuild/rules_python/releases/download/0.27.1/rules_python-0.27.1.tar.gz",
)

load("@rules_python//python:repositories.bzl", "py_repositories", "python_register_toolchains")

py_repositories()

python_register_toolchains(
    name = "python_3_11",
    python_version = "3.11",
)

load("@rules_python//python:pip.bzl", "pip_parse")

pip_parse(
    name = "pip_deps",
    python_interpreter_target = "@python_3_11_host//:python",
    requirements_lock = "//:requirements.txt",
)

load("@pip_deps//:requirements.bzl", "install_deps")

install_deps()

# ============================================================================
# Protobuf
# ============================================================================
http_archive(
    name = "com_google_protobuf",
    strip_prefix = "protobuf-25.3",
    urls = ["https://github.com/protocolbuffers/protobuf/archive/v25.3.tar.gz"],
)

load("@com_google_protobuf//:protobuf_deps.bzl", "protobuf_deps")

protobuf_deps()
