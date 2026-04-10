"""vLLM client for remote model serving.

Talks to a standalone vLLM server over its OpenAI-compatible HTTP API.
The vLLM server runs on a separate GPU machine (see Dockerfile.vllm).

LMCache integration:
    LMCache sits inside the vLLM server to cache KV-cache states.
    This dramatically speeds up repeated / prefix-sharing prompts —
    exactly what SashaSlides needs since every generate call shares the
    same system prompt and often previous conversation context.

Supported models (see models.py for full registry):
    - Mistral 7B          (~5 GB VRAM, fits fully on 24 GB)
    - LLaMA 3 8B          (~6 GB VRAM, fits fully on 24 GB)
    - Qwen 2.5 14B        (~10 GB VRAM, fits fully on 24 GB)
    - LLaMA 3 70B (Q4)    (~20 GB VRAM, AWQ quantized)
    - DeepSeek Coder 33B  (~19 GB VRAM, AWQ quantized)

Usage:
    from sashaslides.composer.vllm_client import VLLMClient
    client = VLLMClient(host="gpu-box.local", port=8000)
    resp = client.chat([ChatMessage(role="user", content="Hello!")])
"""

import logging
import os
from typing import Any, Dict, List, Optional

import requests

from sashaslides.composer.llm_client import ChatMessage, LLMClient, LLMResponse
from sashaslides.composer.models import (
    DEFAULT_MODEL,
    ModelConfig,
    get_model,
)

logger = logging.getLogger(__name__)

_DEFAULT_VLLM_HOST = "localhost"
_DEFAULT_VLLM_PORT = 8000
_REQUEST_TIMEOUT = 120  # seconds


class VLLMClient(LLMClient):
    """Client that talks to a remote vLLM OpenAI-compatible server."""

    def __init__(
        self,
        host: str = "",
        port: int = 0,
        model_id: str = "",
    ) -> None:
        """Initialize the vLLM client.

        Args:
            host: vLLM server host. Defaults to VLLM_HOST env or localhost.
            port: vLLM server port. Defaults to VLLM_PORT env or 8000.
            model_id: Model registry ID (e.g. "llama3-8b"). Defaults to
                VLLM_MODEL env or DEFAULT_MODEL.
        """
        self._host = host or os.environ.get(
            "VLLM_HOST", _DEFAULT_VLLM_HOST
        )
        self._port = port or int(
            os.environ.get("VLLM_PORT", str(_DEFAULT_VLLM_PORT))
        )
        model_key = model_id or os.environ.get(
            "VLLM_MODEL", DEFAULT_MODEL.value
        )
        self._model_config = get_model(model_key)
        self._base_url = f"http://{self._host}:{self._port}"
        self._session = requests.Session()

    # ------------------------------------------------------------------
    # LLMClient interface
    # ------------------------------------------------------------------

    @property
    def backend_name(self) -> str:
        return "vllm"

    @property
    def model_name(self) -> str:
        return self._model_config.model_id

    def chat(
        self,
        messages: List[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        """Send a chat completion request to the vLLM server."""
        payload: Dict[str, Any] = {
            "model": self._model_config.model_id,
            "messages": [
                {"role": m.role, "content": m.content} for m in messages
            ],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if stop:
            payload["stop"] = stop

        data = self._post("/v1/chat/completions", payload)
        choice = data["choices"][0]
        usage = data.get("usage", {})

        return LLMResponse(
            text=choice["message"]["content"],
            model=data.get("model", self._model_config.model_id),
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
        """Send a text completion request to the vLLM server."""
        payload: Dict[str, Any] = {
            "model": self._model_config.model_id,
            "prompt": prompt,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if stop:
            payload["stop"] = stop

        data = self._post("/v1/completions", payload)
        choice = data["choices"][0]
        usage = data.get("usage", {})

        return LLMResponse(
            text=choice["text"],
            model=data.get("model", self._model_config.model_id),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            finish_reason=choice.get("finish_reason", "stop"),
        )

    def health_check(self) -> bool:
        """Check if the vLLM server is healthy."""
        try:
            resp = self._session.get(
                f"{self._base_url}/health", timeout=5
            )
            return resp.status_code == 200
        except requests.ConnectionError:
            return False

    def list_served_models(self) -> List[Dict[str, Any]]:
        """Query the vLLM server for its loaded models."""
        try:
            data = self._get("/v1/models")
            return data.get("data", [])  # type: ignore[no-any-return]
        except Exception:
            return []

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        """POST JSON to the vLLM server and return parsed response."""
        url = f"{self._base_url}{path}"
        try:
            resp = self._session.post(
                url, json=payload, timeout=_REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
            return resp.json()  # type: ignore[no-any-return]
        except requests.ConnectionError as exc:
            raise ConnectionError(
                f"Cannot connect to vLLM server at {self._base_url}. "
                f"Is the server running? Error: {exc}"
            ) from exc
        except requests.HTTPError as exc:
            body = exc.response.text if exc.response is not None else ""
            raise RuntimeError(
                f"vLLM request failed "
                f"({exc.response.status_code if exc.response else '?'}): {body}"
            ) from exc

    def _get(self, path: str) -> Dict[str, Any]:
        """GET from the vLLM server and return parsed response."""
        url = f"{self._base_url}{path}"
        resp = self._session.get(url, timeout=10)
        resp.raise_for_status()
        return resp.json()  # type: ignore[no-any-return]
