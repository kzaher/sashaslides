load("@rules_python//python:defs.bzl", "py_library")
load("@pip_deps//:requirements.bzl", "requirement")

proto_library(
    name = "sashaslides_proto",
    srcs = ["sashaslides.proto"],
    visibility = ["//visibility:public"],
)

# Generate Python protobuf code via Bazel-managed protoc.
genrule(
    name = "sashaslides_proto_gen",
    srcs = ["sashaslides.proto"],
    outs = [
        "sashaslides_pb2.py",
        "sashaslides_pb2.pyi",
    ],
    cmd = "$(location @com_google_protobuf//:protoc) " +
          "--proto_path=proto " +
          "--python_out=$(RULEDIR) " +
          "--pyi_out=$(RULEDIR) " +
          "$(location sashaslides.proto)",
    tools = ["@com_google_protobuf//:protoc"],
)

py_library(
    name = "sashaslides_py_proto",
    srcs = [
        "__init__.py",
        ":sashaslides_proto_gen",
    ],
    imports = [".."],
    deps = [
        requirement("protobuf"),
    ],
    visibility = ["//visibility:public"],
)
