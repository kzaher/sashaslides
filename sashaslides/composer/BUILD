load("@rules_python//python:defs.bzl", "py_binary", "py_library", "py_test")
load("@pip_deps//:requirements.bzl", "requirement")

py_library(
    name = "claude_client",
    srcs = ["claude_client.py"],
    visibility = ["//visibility:public"],
    deps = [
        "//proto:sashaslides_py_proto",
        requirement("protobuf"),
    ],
)

py_library(
    name = "http_client",
    srcs = ["http_client.py"],
    visibility = ["//visibility:public"],
    deps = [
        "//proto:sashaslides_py_proto",
        requirement("protobuf"),
        requirement("requests"),
    ],
)

py_binary(
    name = "server",
    srcs = ["server.py"],
    visibility = ["//visibility:public"],
    deps = [
        ":claude_client",
        "//proto:sashaslides_py_proto",
        requirement("flask"),
        requirement("protobuf"),
    ],
)

py_test(
    name = "server_test",
    srcs = ["server_test.py"],
    deps = [
        ":claude_client",
        ":http_client",
        ":server",
        "//proto:sashaslides_py_proto",
        requirement("flask"),
        requirement("protobuf"),
        requirement("requests"),
    ],
)
