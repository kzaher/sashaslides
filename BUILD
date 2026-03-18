# Root BUILD file for SashaSlides.

load("@rules_python//python:defs.bzl", "py_binary")
load("@pip_deps//:requirements.bzl", "requirement")

exports_files(["requirements.txt", "requirements_lock.txt"])

# Convenience target: run all tests
test_suite(
    name = "all_tests",
    tests = [
        "//sashaslides/chatbot:bot_test",
        "//sashaslides/composer:server_test",
        "//sashaslides/db:database_test",
    ],
)
