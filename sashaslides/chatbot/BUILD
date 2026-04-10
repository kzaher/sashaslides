load("@rules_python//python:defs.bzl", "py_binary", "py_library", "py_test")
load("@pip_deps//:requirements.bzl", "requirement")

py_library(
    name = "bot",
    srcs = ["bot.py"],
    visibility = ["//visibility:public"],
    deps = [
        "//proto:sashaslides_py_proto",
        "//sashaslides/composer:claude_client",
        "//sashaslides/db:database",
        requirement("protobuf"),
    ],
)

py_binary(
    name = "mock_interface",
    srcs = ["mock_interface.py"],
    visibility = ["//visibility:public"],
    deps = [
        ":bot",
        "//proto:sashaslides_py_proto",
        "//sashaslides/composer:claude_client",
        "//sashaslides/db:database",
        requirement("protobuf"),
    ],
)

py_test(
    name = "bot_test",
    srcs = ["bot_test.py"],
    deps = [
        ":bot",
        "//proto:sashaslides_py_proto",
        "//sashaslides/composer:claude_client",
        "//sashaslides/db:database",
        requirement("protobuf"),
    ],
)
