"""Stubbed Claude Haiku client for generating slide suggestions.

When a real API key is provided, this client will call Claude Haiku to
generate slide content. For now it returns deterministic stub responses
that follow the Google Slides API Page resource format.
"""

import json
import os
from typing import Any, Dict, List

from proto import sashaslides_pb2


# Slide color palettes — each suggestion gets its own vibe
_PALETTES: List[Dict[str, float]] = [
    {"red": 0.95, "green": 0.77, "blue": 0.81},  # Romantic pink
    {"red": 0.68, "green": 0.85, "blue": 0.90},  # Icy blue
    {"red": 0.80, "green": 0.95, "blue": 0.73},  # Forest green
    {"red": 0.98, "green": 0.92, "blue": 0.65},  # Sunny yellow
]

# Funny descriptions, one per suggestion
_DESCRIPTIONS: List[str] = [
    "Zis one iz classic and elegant, like babushka's best china.",
    "More modern approach, very hip, very cool, like bear on skateboard.",
    "Bold and dramatic! Will make audience say 'blyat, zis iz good!'",
    "Clean and minimal, like Siberian winter landscape. Beautifool.",
]


class ClaudeClient:
    """Client for Claude Haiku API. Currently returns stub data."""

    def __init__(self, api_key: str = "") -> None:
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self._is_stub = not self._api_key or self._api_key == "stub"

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def generate_slide_suggestions(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        """Generate 4 slide suggestions. Currently returns stub data.

        When a real API key is configured, this will call Claude Haiku
        to generate proper slide content.
        """
        if not self._is_stub:
            return self._generate_with_claude(request)
        return self._generate_stub(request)

    def _generate_with_claude(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        """Placeholder for real Claude API integration."""
        # TODO: Implement real Claude Haiku API call
        # When implemented, this will:
        # 1. Build a prompt describing the slide requirements
        # 2. Call Claude Haiku via the Anthropic SDK
        # 3. Parse the response into Google Slides API format
        # 4. Return 4 candidates
        return self._generate_stub(request)

    def _generate_stub(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        """Generate deterministic stub slide suggestions."""
        response = sashaslides_pb2.GenerateSlideResponse()
        prompt_text = request.user_prompt or "Untitled Slide"

        for i in range(4):
            candidate = response.candidates.add()
            candidate.title = f"Option {i + 1}: {prompt_text}"
            candidate.description = _DESCRIPTIONS[i]
            candidate.content_json = json.dumps(
                self._make_slide_page(
                    title=candidate.title,
                    body=self._make_body_text(prompt_text, i),
                    variant=i,
                )
            )

        return response

    def _make_body_text(self, prompt: str, variant: int) -> str:
        """Generate different body text variants."""
        templates = [
            (
                f"• Introduction to {prompt}\n"
                f"• Key concepts and overview\n"
                f"• Why this matters for your team"
            ),
            (
                f"📊 Data-driven look at {prompt}\n"
                f"• Statistics and metrics\n"
                f"• Trends and projections\n"
                f"• Action items"
            ),
            (
                f"🎯 {prompt}\n\n"
                f"The Big Picture:\n"
                f"This slide demonstrates the core value proposition "
                f"with bold visuals and minimal text."
            ),
            (
                f"✨ {prompt}\n\n"
                f"Key Takeaways:\n"
                f"1. First important point\n"
                f"2. Second important point\n"
                f"3. Third important point"
            ),
        ]
        return templates[variant % len(templates)]

    @staticmethod
    def _make_slide_page(
        title: str, body: str, variant: int
    ) -> Dict[str, Any]:
        """Build a Google Slides API Page resource (stub).

        Follows the structure from:
        https://developers.google.com/slides/api/reference/rest/v1/presentations.pages
        """
        color = _PALETTES[variant % len(_PALETTES)]
        return {
            "objectId": f"slide_suggestion_{variant}",
            "pageElements": [
                {
                    "objectId": f"title_{variant}",
                    "size": {
                        "height": {"magnitude": 80, "unit": "PT"},
                        "width": {"magnitude": 600, "unit": "PT"},
                    },
                    "transform": {
                        "scaleX": 1.0,
                        "scaleY": 1.0,
                        "translateX": 50.0,
                        "translateY": 30.0,
                        "unit": "PT",
                    },
                    "shape": {
                        "shapeType": "TEXT_BOX",
                        "text": {
                            "textElements": [
                                {
                                    "textRun": {
                                        "content": title,
                                        "style": {
                                            "fontSize": {
                                                "magnitude": 28,
                                                "unit": "PT",
                                            },
                                            "bold": True,
                                        },
                                    }
                                }
                            ]
                        },
                    },
                },
                {
                    "objectId": f"body_{variant}",
                    "size": {
                        "height": {"magnitude": 300, "unit": "PT"},
                        "width": {"magnitude": 600, "unit": "PT"},
                    },
                    "transform": {
                        "scaleX": 1.0,
                        "scaleY": 1.0,
                        "translateX": 50.0,
                        "translateY": 130.0,
                        "unit": "PT",
                    },
                    "shape": {
                        "shapeType": "TEXT_BOX",
                        "text": {
                            "textElements": [
                                {
                                    "textRun": {
                                        "content": body,
                                        "style": {
                                            "fontSize": {
                                                "magnitude": 16,
                                                "unit": "PT",
                                            },
                                        },
                                    }
                                }
                            ]
                        },
                    },
                },
            ],
            "pageProperties": {
                "pageBackgroundFill": {
                    "solidFill": {
                        "color": {"rgbColor": color},
                    }
                }
            },
        }
