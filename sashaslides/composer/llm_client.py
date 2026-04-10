"""Abstract LLM client interface for SashaSlides.

Defines the common protocol that all LLM backends (vLLM, OpenAI, Claude)
must implement. The Composer service programs against this interface so
that backends are swappable.
"""

import abc
from dataclasses import dataclass, field
from typing import Dict, List, Optional


@dataclass
class ChatMessage:
    """A single message in a chat conversation."""
    role: str  # "system", "user", "assistant"
    content: str


@dataclass
class LLMResponse:
    """Response from an LLM completion call."""
    text: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    finish_reason: str = "stop"
    metadata: Dict[str, object] = field(default_factory=dict)


class LLMClient(abc.ABC):
    """Abstract base for LLM backends.

    All LLM integrations (vLLM local, OpenAI API, Anthropic API)
    implement this interface so the Composer can swap backends freely.
    """

    @property
    @abc.abstractmethod
    def backend_name(self) -> str:
        """Human-readable name for this backend, e.g. 'vllm', 'openai'."""
        ...

    @property
    @abc.abstractmethod
    def model_name(self) -> str:
        """Currently loaded model identifier."""
        ...

    @property
    def is_stub(self) -> bool:
        """Whether this client returns stub/mock data."""
        return False

    @abc.abstractmethod
    def chat(
        self,
        messages: List[ChatMessage],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        """Send a chat-completion request."""
        ...

    @abc.abstractmethod
    def complete(
        self,
        prompt: str,
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        stop: Optional[List[str]] = None,
    ) -> LLMResponse:
        """Send a raw text-completion request."""
        ...

    def health_check(self) -> bool:
        """Return True if the backend is reachable and ready."""
        return True
