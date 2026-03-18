"""Flask server for the SashaSlides Composer service.

Exposes HTTP endpoints for generating slide suggestions.
The Composer takes a GenerateSlideRequest and returns 4 SlideCandidate
options via Claude Haiku (currently stubbed).

Usage:
    python -m sashaslides.composer.server
    # or via Bazel:
    bazel run //sashaslides/composer:server
"""

import os

from flask import Flask, Response, request
from google.protobuf import json_format

from proto import sashaslides_pb2
from sashaslides.composer.claude_client import ClaudeClient

app = Flask(__name__)
client = ClaudeClient()


@app.route("/health", methods=["GET"])
def health() -> Response:
    """Health check endpoint."""
    return Response(
        '{"status": "ok", "message": "Composer iz alive and kicking, da!"}',
        status=200,
        mimetype="application/json",
    )


@app.route("/generate", methods=["POST"])
def generate() -> Response:
    """Generate 4 slide suggestions from a GenerateSlideRequest.

    Accepts JSON-serialized GenerateSlideRequest protobuf.
    Returns JSON-serialized GenerateSlideResponse protobuf.
    """
    req = sashaslides_pb2.GenerateSlideRequest()
    json_format.Parse(request.get_data(as_text=True), req)

    response = client.generate_slide_suggestions(req)

    return Response(
        json_format.MessageToJson(
            response, preserving_proto_field_name=True
        ),
        status=200,
        mimetype="application/json",
    )


@app.route("/", methods=["GET"])
def index() -> Response:
    """Root endpoint with a friendly greeting."""
    return Response(
        '{"service": "SashaSlides Composer", '
        '"message": "Send POST to /generate with GenerateSlideRequest, comrade!", '
        f'"stub_mode": {str(client.is_stub).lower()}}}',
        status=200,
        mimetype="application/json",
    )


def main() -> None:
    """Run the Composer Flask server."""
    port = int(os.environ.get("COMPOSER_PORT", "8080"))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    print(f"🐻 SashaSlides Composer starting on port {port}...")
    print(f"   Stub mode: {client.is_stub}")
    app.run(host="0.0.0.0", port=port, debug=debug)


if __name__ == "__main__":
    main()
