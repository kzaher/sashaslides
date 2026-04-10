"""Slide generation engine using pluggable LLM backends.

Bridges the LLMClient interface with the SashaSlides protobuf types.
Builds prompts, calls the LLM, and parses responses into SlideCandidate
protos. Falls back to deterministic stubs when no LLM is available.

The default backend is vLLM + LMCache served from a remote GPU machine.
Claude and OpenAI backends are also supported.
"""

import json
import logging
import os
from typing import Any, Dict, List, Optional

from proto import sashaslides_pb2
from sashaslides.composer.llm_client import ChatMessage, LLMClient, LLMResponse

logger = logging.getLogger(__name__)

# ============================================================================
# System prompt
# ============================================================================

_SYSTEM_PROMPT = """\
You are SashaSlides, an expert presentation designer AI with a friendly \
Russian-accented personality. You generate Google Slides content in JSON \
format following the Google Slides API Page resource structure.

When asked to create a slide, you MUST respond with EXACTLY 4 JSON objects \
separated by the delimiter "---SLIDE---". Each JSON object represents a \
different design option for the same content.

Each JSON object must follow this structure:
{
  "title": "Option N: <descriptive title>",
  "description": "<witty one-line description in your personality>",
  "page": { ... Google Slides API Page resource ... }
}

Make each option visually distinct: vary colors, layouts, and content style.
"""

# ============================================================================
# Stub palettes & descriptions (used when LLM is unavailable)
# ============================================================================

_PALETTES: List[Dict[str, float]] = [
    {"red": 0.95, "green": 0.77, "blue": 0.81},
    {"red": 0.68, "green": 0.85, "blue": 0.90},
    {"red": 0.80, "green": 0.95, "blue": 0.73},
    {"red": 0.98, "green": 0.92, "blue": 0.65},
]

_DESCRIPTIONS: List[str] = [
    "Zis one iz classic and elegant, like babushka's best china.",
    "More modern approach, very hip, very cool, like bear on skateboard.",
    "Bold and dramatic! Will make audience say 'blyat, zis iz good!'",
    "Clean and minimal, like Siberian winter landscape. Beautifool.",
]


class SlideGenerator:
    """Generates slide suggestions using a pluggable LLM backend."""

    def __init__(self, llm: Optional[LLMClient] = None) -> None:
        self._llm = llm
        self._use_llm = llm is not None and not llm.is_stub

    @property
    def is_stub(self) -> bool:
        return not self._use_llm

    @property
    def backend_name(self) -> str:
        if self._llm is not None:
            return self._llm.backend_name
        return "stub"

    @property
    def model_name(self) -> str:
        if self._llm is not None:
            return self._llm.model_name
        return "stub"

    def generate_slide_suggestions(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        """Generate 4 slide suggestions."""
        if self._use_llm:
            return self._generate_with_llm(request)
        return self._generate_stub(request)

    # ------------------------------------------------------------------
    # LLM-powered generation
    # ------------------------------------------------------------------

    def _generate_with_llm(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        assert self._llm is not None
        messages = self._build_messages(request)

        try:
            llm_response = self._llm.chat(
                messages, temperature=0.8, max_tokens=4096,
            )
            return self._parse_llm_response(llm_response, request)
        except Exception as exc:
            logger.warning(
                "LLM generation failed, falling back to stub: %s", exc
            )
            return self._generate_stub(request)

    def _build_messages(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> List[ChatMessage]:
        messages: List[ChatMessage] = [
            ChatMessage(role="system", content=_SYSTEM_PROMPT),
        ]

        # Replay conversation history
        if request.HasField("conversation"):
            for step in request.conversation.steps:
                kind = step.WhichOneof("kind")
                if kind == "user_response":
                    messages.append(
                        ChatMessage(role="user", content=step.user_response.text)
                    )
                elif kind == "code_execution":
                    messages.append(
                        ChatMessage(
                            role="assistant",
                            content=f"[Generated: {step.code_execution.output}]",
                        )
                    )

        user_text = f"Create a slide about: {request.user_prompt}"
        if request.existing_slide_json:
            user_text += (
                f"\n\nHere is the existing slide to improve:\n"
                f"{request.existing_slide_json}"
            )
        if request.slide_number > 0:
            user_text += f"\n\nThis is for slide number {request.slide_number}."
        messages.append(ChatMessage(role="user", content=user_text))
        return messages

    def _parse_llm_response(
        self,
        llm_response: LLMResponse,
        request: sashaslides_pb2.GenerateSlideRequest,
    ) -> sashaslides_pb2.GenerateSlideResponse:
        response = sashaslides_pb2.GenerateSlideResponse()
        prompt_text = request.user_prompt or "Untitled Slide"
        parts = llm_response.text.split("---SLIDE---")
        candidates_parsed = 0

        for part in parts:
            part = part.strip()
            if not part:
                continue
            try:
                data = json.loads(part)
                candidate = response.candidates.add()
                candidate.title = data.get("title", f"Option: {prompt_text}")
                candidate.description = data.get("description", "")
                candidate.content_json = json.dumps(data.get("page", data))
                candidates_parsed += 1
                if candidates_parsed >= 4:
                    break
            except json.JSONDecodeError:
                extracted = self._extract_json(part)
                if extracted:
                    candidate = response.candidates.add()
                    candidate.title = extracted.get("title", f"Option: {prompt_text}")
                    candidate.description = extracted.get("description", "")
                    candidate.content_json = json.dumps(extracted.get("page", extracted))
                    candidates_parsed += 1
                    if candidates_parsed >= 4:
                        break

        # Pad to 4 with stubs
        while len(response.candidates) < 4:
            idx = len(response.candidates)
            stub = response.candidates.add()
            stub.title = f"Option {idx + 1}: {prompt_text}"
            stub.description = _DESCRIPTIONS[idx % len(_DESCRIPTIONS)]
            stub.content_json = json.dumps(
                self._make_stub_page(stub.title, f"Content for: {prompt_text}", idx)
            )

        self._build_conversation(response, request, prompt_text)
        return response

    @staticmethod
    def _extract_json(text: str) -> Optional[Dict[str, Any]]:
        start = text.find("{")
        if start == -1:
            return None
        depth = 0
        for i in range(start, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])  # type: ignore[no-any-return]
                    except json.JSONDecodeError:
                        return None
        return None

    # ------------------------------------------------------------------
    # Stub generation (same logic as original claude_client.py)
    # ------------------------------------------------------------------

    def _generate_stub(
        self, request: sashaslides_pb2.GenerateSlideRequest
    ) -> sashaslides_pb2.GenerateSlideResponse:
        response = sashaslides_pb2.GenerateSlideResponse()
        prompt_text = request.user_prompt or "Untitled Slide"

        for i in range(4):
            candidate = response.candidates.add()
            candidate.title = f"Option {i + 1}: {prompt_text}"
            candidate.description = _DESCRIPTIONS[i]
            candidate.content_json = json.dumps(
                self._make_stub_page(
                    candidate.title, self._make_body_text(prompt_text, i), i
                )
            )

        self._build_conversation(response, request, prompt_text)
        return response

    @staticmethod
    def _build_conversation(
        response: sashaslides_pb2.GenerateSlideResponse,
        request: sashaslides_pb2.GenerateSlideRequest,
        prompt_text: str,
    ) -> None:
        conversation = sashaslides_pb2.Conversation()
        if request.HasField("conversation"):
            conversation.CopyFrom(request.conversation)
        if not conversation.prompt:
            conversation.prompt = "SashaSlides slide generation conversation"

        user_step = conversation.steps.add()
        user_step.user_response.CopyFrom(
            sashaslides_pb2.UserResponse(text=prompt_text)
        )

        gen_step = conversation.steps.add()
        gen_step.code_execution.CopyFrom(
            sashaslides_pb2.CodeExecution(
                python_code="generate_slides(prompt)",
                output=f"Generated 4 candidates for: {prompt_text}",
                exit_code="0",
            )
        )
        response.conversation.CopyFrom(conversation)

    @staticmethod
    def _make_body_text(prompt: str, variant: int) -> str:
        templates = [
            (
                f"\u2022 Introduction to {prompt}\n"
                f"\u2022 Key concepts and overview\n"
                f"\u2022 Why this matters for your team"
            ),
            (
                f"\U0001f4ca Data-driven look at {prompt}\n"
                f"\u2022 Statistics and metrics\n"
                f"\u2022 Trends and projections\n"
                f"\u2022 Action items"
            ),
            (
                f"\U0001f3af {prompt}\n\n"
                f"The Big Picture:\n"
                f"This slide demonstrates the core value proposition "
                f"with bold visuals and minimal text."
            ),
            (
                f"\u2728 {prompt}\n\n"
                f"Key Takeaways:\n"
                f"1. First important point\n"
                f"2. Second important point\n"
                f"3. Third important point"
            ),
        ]
        return templates[variant % len(templates)]

    @staticmethod
    def _make_stub_page(title: str, body: str, variant: int) -> Dict[str, Any]:
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
                        "scaleX": 1.0, "scaleY": 1.0,
                        "translateX": 50.0, "translateY": 30.0, "unit": "PT",
                    },
                    "shape": {
                        "shapeType": "TEXT_BOX",
                        "text": {
                            "textElements": [{
                                "textRun": {
                                    "content": title,
                                    "style": {
                                        "fontSize": {"magnitude": 28, "unit": "PT"},
                                        "bold": True,
                                    },
                                }
                            }]
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
                        "scaleX": 1.0, "scaleY": 1.0,
                        "translateX": 50.0, "translateY": 130.0, "unit": "PT",
                    },
                    "shape": {
                        "shapeType": "TEXT_BOX",
                        "text": {
                            "textElements": [{
                                "textRun": {
                                    "content": body,
                                    "style": {
                                        "fontSize": {"magnitude": 16, "unit": "PT"},
                                    },
                                }
                            }]
                        },
                    },
                },
            ],
            "pageProperties": {
                "pageBackgroundFill": {
                    "solidFill": {"color": {"rgbColor": color}}
                }
            },
        }


def create_default_generator() -> SlideGenerator:
    """Create a SlideGenerator with the default backend.

    Backend priority:
        1. vLLM (if VLLM_HOST is set — remote GPU server)
        2. OpenAI (if OPENAI_API_KEY is set)
        3. Anthropic/Claude (if ANTHROPIC_API_KEY is set and != "stub")
        4. Stub mode (no LLM, deterministic responses)

    The default is vLLM + LMCache on a remote GPU machine.
    """
    backend = os.environ.get("LLM_BACKEND", "").lower()

    if backend == "openai":
        from sashaslides.composer.openai_client import OpenAIClient
        return SlideGenerator(llm=OpenAIClient())
    elif backend in ("anthropic", "claude"):
        from sashaslides.composer.anthropic_client import AnthropicClient
        return SlideGenerator(llm=AnthropicClient())
    elif backend == "stub":
        return SlideGenerator(llm=None)
    elif backend == "vllm" or backend == "":
        return _create_vllm_generator()

    logger.warning("Unknown LLM_BACKEND '%s', falling back to vLLM", backend)
    return _create_vllm_generator()


def _create_vllm_generator() -> SlideGenerator:
    """Create a SlideGenerator with the remote vLLM backend."""
    vllm_host = os.environ.get("VLLM_HOST", "")

    if vllm_host:
        from sashaslides.composer.vllm_client import VLLMClient
        try:
            client = VLLMClient()
            if client.health_check():
                logger.info("Using vLLM backend at %s: %s", vllm_host, client.model_name)
                return SlideGenerator(llm=client)
            else:
                logger.warning("vLLM server at %s not reachable", vllm_host)
        except Exception as exc:
            logger.warning("vLLM not available: %s", exc)

    # Fall through
    openai_key = os.environ.get("OPENAI_API_KEY", "")
    if openai_key:
        from sashaslides.composer.openai_client import OpenAIClient
        logger.info("Falling back to OpenAI backend")
        return SlideGenerator(llm=OpenAIClient())

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if anthropic_key and anthropic_key != "stub":
        from sashaslides.composer.anthropic_client import AnthropicClient
        logger.info("Falling back to Anthropic backend")
        return SlideGenerator(llm=AnthropicClient())

    logger.info("No LLM backend available, using stub mode")
    return SlideGenerator(llm=None)
