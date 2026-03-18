load("@rules_python//python:defs.bzl", "py_library", "py_test")
load("@pip_deps//:requirements.bzl", "requirement")

py_library(
    name = "database",
    srcs = ["database.py"],
    visibility = ["//visibility:public"],
    deps = [
        "//proto:sashaslides_py_proto",
        requirement("protobuf"),
    ],
)

py_test(
    name = "database_test",
    srcs = ["database_test.py"],
    deps = [
        ":database",
        "//proto:sashaslides_py_proto",
        requirement("protobuf"),
    ],
)
