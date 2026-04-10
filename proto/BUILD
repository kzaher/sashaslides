load("@rules_python//python:defs.bzl", "py_library")

proto_library(
    name = "sashaslides_proto",
    srcs = ["sashaslides.proto"],
    visibility = ["//visibility:public"],
)

py_proto_library(
    name = "sashaslides_py_proto",
    deps = [":sashaslides_proto"],
    visibility = ["//visibility:public"],
)
