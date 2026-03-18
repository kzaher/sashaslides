"""Tests for the SashaSlides Composer service."""

import json
import threading
import unittest

from google.protobuf import json_format
from werkzeug.serving import make_server

from proto import sashaslides_pb2
from sashaslides.composer.claude_client import ClaudeClient
from sashaslides.composer.http_client import ComposerHttpClient
from sashaslides.composer.server import app


class TestClaudeClient(unittest.TestCase):
    """Tests for the stubbed Claude Haiku client."""

    def setUp(self) -> None:
        self.client = ClaudeClient()

    def test_is_stub_by_default(self) -> None:
        self.assertTrue(self.client.is_stub)

    def test_generates_four_candidates(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url="https://docs.google.com/presentation/d/test",
            user_prompt="Machine learning overview",
        )
        response = self.client.generate_slide_suggestions(request)
        self.assertEqual(len(response.candidates), 4)

    def test_candidates_have_content(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            user_prompt="Quarterly results",
        )
        response = self.client.generate_slide_suggestions(request)

        for i, candidate in enumerate(response.candidates):
            self.assertIn("Quarterly results", candidate.title)
            self.assertTrue(candidate.description)
            self.assertTrue(candidate.content_json)

            # Validate JSON is parseable
            page = json.loads(candidate.content_json)
            self.assertIn("objectId", page)
            self.assertIn("pageElements", page)
            self.assertIn("pageProperties", page)

    def test_content_follows_slides_api_format(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            user_prompt="Test slide",
        )
        response = self.client.generate_slide_suggestions(request)
        page = json.loads(response.candidates[0].content_json)

        # Check page elements structure
        elements = page["pageElements"]
        self.assertEqual(len(elements), 2)  # title + body

        # Check title element
        title_el = elements[0]
        self.assertIn("shape", title_el)
        self.assertEqual(title_el["shape"]["shapeType"], "TEXT_BOX")
        self.assertIn("text", title_el["shape"])

        # Check background fill
        bg = page["pageProperties"]["pageBackgroundFill"]
        self.assertIn("solidFill", bg)

    def test_new_slide_request(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url="https://docs.google.com/presentation/d/test",
            slide_number=0,
            user_prompt="New intro slide",
        )
        response = self.client.generate_slide_suggestions(request)
        self.assertEqual(len(response.candidates), 4)

    def test_improve_existing_slide(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url="https://docs.google.com/presentation/d/test",
            slide_number=3,
            user_prompt="Improve slide number 3",
            existing_slide_json='{"objectId": "existing"}',
        )
        response = self.client.generate_slide_suggestions(request)
        self.assertEqual(len(response.candidates), 4)


class TestComposerServer(unittest.TestCase):
    """Tests for the Flask Composer server endpoints."""

    def setUp(self) -> None:
        app.config["TESTING"] = True
        self.app = app.test_client()

    def test_health_endpoint(self) -> None:
        response = self.app.get("/health")
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertEqual(data["status"], "ok")

    def test_root_endpoint(self) -> None:
        response = self.app.get("/")
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertEqual(data["service"], "SashaSlides Composer")

    def test_generate_endpoint(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url="https://docs.google.com/presentation/d/abc",
            user_prompt="Team building activities",
        )
        request_json = json_format.MessageToJson(
            request, preserving_proto_field_name=True
        )

        response = self.app.post(
            "/generate",
            data=request_json,
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)

        resp_proto = sashaslides_pb2.GenerateSlideResponse()
        json_format.Parse(response.data.decode(), resp_proto)
        self.assertEqual(len(resp_proto.candidates), 4)

    def test_generate_minimal_request(self) -> None:
        request_json = '{"user_prompt": "Hello"}'
        response = self.app.post(
            "/generate",
            data=request_json,
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)


class TestComposerHttpClient(unittest.TestCase):
    """Tests for the HTTP client talking to the Flask server."""

    def setUp(self) -> None:
        app.config["TESTING"] = True
        self._server = make_server("127.0.0.1", 0, app)
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            daemon=True,
        )
        self._thread.start()
        host, port = self._server.server_address
        self.client = ComposerHttpClient(f"http://{host}:{port}")

    def tearDown(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    def test_generate_slide_suggestions_over_http(self) -> None:
        request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url="https://docs.google.com/presentation/d/http",
            user_prompt="Roadmap update",
        )

        response = self.client.generate_slide_suggestions(request)

        self.assertEqual(len(response.candidates), 4)
        self.assertIn("Roadmap update", response.candidates[0].title)
        self.assertTrue(response.candidates[0].content_json)


if __name__ == "__main__":
    unittest.main()
