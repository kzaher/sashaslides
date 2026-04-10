"""OpenAI-compatible LLM client for SashaSlides.

Wraps the OpenAI chat/completions API format. Supports both the official
OpenAI API and any OpenAI-compatible endpoint (Azure, Together AI,
Anyscale, local vLLM, Ollama, etc.) by setting a custom base_url.

Usage:
    from sashaslides.composer.openai_client import OpenAIClient
    client = OpenAIClient(api_key="sk-...", model="gpt-4o")
"""

import os
from typing import Any, Dict, List, Optional

import requests

from sashaslides.composer.llm_client import ChatMessage, LLMClient, LLMResponse

_DEFAULT_MODEL = "gpt-4o"
_DEFAULT_TIMEOUT = 60


class OpenAIClient(LLMClient):
    """LLM client using the OpenAI chat/completions API format."""

    def __init__(
        self,
        api_key: str = "",
        model: str = "",
        base_url: str = "",
        timeout: int = _DEFAULT_TIMEOUT,
    ) -> None:
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        self._model = model or os.environ.get("OPENAI_MODEL", _DEFAULT_MODEL)
        self._base_url = (
            base_url
            or os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
        ).rstrip("/")
        self._timeout = timeout
        self._session = requests.Session()
        self._is_stub = not self._api_key

    @property
    def backend_name(self) -> str:
        return "openai"

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
        payload: Dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": m.role, "content": m.content} for m in messages
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if stop:
            payload["stop"] = stop

        data = self._post("/chat/completions", payload)
        choice = data["choices"][0]
        usage = data.get("usage", {})

        return LLMResponse(
            text=choice["message"]["content"],
            model=data.get("model", self._model),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            finish_reason=choice.get("finish_reason", "stop"),
        )

    def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        payload: Dict[str, Any] = {
            "model": self._model,
            "prompt": prompt,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if stop:
            payload["stop"] = stop

        data = self._post("/completions", payload)
        choice = data["choices"][0]
        usage = data.get("usage", {})

        return LLMResponse(
            text=choice["text"],
            model=data.get("model", self._model),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            finish_reason=choice.get("finish_reason", "stop"),
        )

    def health_check(self) -> bool:
        try:
            resp = self._session.get(
                f"{self._base_url}/models",
                headers=self._headers(),
                timeout=5,
            )
            return resp.status_code == 200
        except requests.ConnectionError:
            return False

    def _headers(self) -> Dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

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
                f"Cannot connect to OpenAI API at {self._base_url}: {exc}"
            ) from exc
        except requests.HTTPError as exc:
            body = exc.response.text if exc.response is not None else ""
            raise RuntimeError(
                f"OpenAI API error "
                f"({exc.response.status_code if exc.response else '?'}): {body}"
            ) from exc
