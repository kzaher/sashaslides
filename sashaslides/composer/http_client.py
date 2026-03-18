"""HTTP client for the SashaSlides Composer Flask service."""

from google.protobuf import json_format
import requests

from proto import sashaslides_pb2

_DEFAULT_TIMEOUT_SECONDS = 30


class ComposerHttpClient:
    """Talk to the Composer service over HTTP."""

    def __init__(
        self,
        base_url: str,
        timeout_seconds: int = _DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    def generate_slide_suggestions(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        """Request slide suggestions from the Composer server."""
        response = requests.post(
            f"{self._base_url}/generate",
            data=json_format.MessageToJson(
                request, preserving_proto_field_name=True
            ),
            headers={"Content-Type": "application/json"},
            timeout=self._timeout_seconds,
        )
        response.raise_for_status()

        proto = sashaslides_pb2.GenerateSlideResponse()
        json_format.Parse(response.text, proto)
        return proto