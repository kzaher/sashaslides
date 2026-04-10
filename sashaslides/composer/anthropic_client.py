"""Anthropic Claude LLM client for SashaSlides.

Provides an LLMClient implementation that talks to the Anthropic
Messages API. Supports Claude Haiku, Sonnet, and Opus models.

Usage:
    from sashaslides.composer.anthropic_client import AnthropicClient
    client = AnthropicClient(api_key="sk-ant-...")
"""

import os
from typing import Any, Dict, List, Optional

import requests

from sashaslides.composer.llm_client import ChatMessage, LLMClient, LLMResponse

_DEFAULT_MODEL = "claude-sonnet-4-20250514"
_DEFAULT_TIMEOUT = 60
_API_VERSION = "2023-06-01"
_BASE_URL = "https://api.anthropic.com"


class AnthropicClient(LLMClient):
    """LLM client using the Anthropic Messages API."""

    def __init__(
        self,
        api_key: str = "",
        model: str = "",
        base_url: str = "",
        timeout: int = _DEFAULT_TIMEOUT,
    ) -> None:
        self._api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self._model = model or os.environ.get(
            "ANTHROPIC_MODEL", _DEFAULT_MODEL
        )
        self._base_url = (
            base_url or os.environ.get("ANTHROPIC_BASE_URL", _BASE_URL)
        ).rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()
        self._is_stub = not self._api_key or self._api_key == "stub"

    @property
    def backend_name(self) -> str:
        return "anthropic"

    @property
    def model_name(self) -> str:
        return self._model

    @property
    def is_stub(self) -> bool:
        return self._is_stub

    def chat(
        self,
        messages: List[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        # Separate system prompt from conversation messages
        system_text = ""
        conversation: List[Dict[str, str]] = []
        for msg in messages:
            if msg.role == "system":
                system_text = msg.content
            else:
                conversation.append(
                    {"role": msg.role, "content": msg.content}
                )

        payload: Dict[str, Any] = {
            "model": self._model,
            "messages": conversation,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system_text:
            payload["system"] = system_text
        if stop:
            payload["stop_sequences"] = stop

        data = self._post("/v1/messages", payload)

        text_parts = []
        for block in data.get("content", []):
            if block.get("type") == "text":
                text_parts.append(block["text"])
        text = "\n".join(text_parts)

        usage = data.get("usage", {})
        return LLMResponse(
            text=text,
            model=data.get("model", self._model),
            prompt_tokens=usage.get("input_tokens", 0),
            completion_tokens=usage.get("output_tokens", 0),
            finish_reason=data.get("stop_reason", "end_turn"),
        )

    def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        # Wrap as a user message since Anthropic only has Messages API
        messages = [ChatMessage(role="user", content=prompt)]
        return self.chat(
            messages, temperature=temperature,
            max_tokens=max_tokens, stop=stop,
        )

    def health_check(self) -> bool:
        return bool(self._api_key) and self._api_key != "stub"

    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "x-api-key": self._api_key,
            "anthropic-version": _API_VERSION,
        }

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.post(
                url, json=payload,
                headers=self._headers(),
                timeout=self._timeout,
            )
            resp.raise_for_status()
            return resp.json()  # type: ignore[no-any-return]
        except requests.ConnectionError as exc:
            raise ConnectionError(
                f"Cannot connect to Anthropic API at {self._base_url}: {exc}"
            ) from exc
        except requests.HTTPError as exc:
            body = exc.response.text if exc.response is not None else ""
            raise RuntimeError(
                f"Anthropic API error "
                f"({exc.response.status_code if exc.response else '?'}): {body}"
            ) from exc
