"""Model registry for SashaSlides LLM backends.

Defines supported models with their HuggingFace IDs, resource requirements,
and recommended configurations. vLLM + LMCache is the default serving stack.
"""

import enum
from dataclasses import dataclass, field
from typing import Dict, Optional


class Quantization(enum.Enum):
    """Quantization format for model weights."""
    NONE = "none"
    AWQ = "awq"
    GPTQ = "gptq"
    GGUF = "gguf"


@dataclass(frozen=True)
class ModelConfig:
    """Configuration for a single LLM model."""

    # Display name
    name: str

    # HuggingFace model ID (or local path)
    model_id: str

    # Parameter count in billions
    param_billions: float

    # Approximate VRAM usage in GB
    vram_gb: float

    # Maximum context length (tokens)
    max_model_len: int = 4096

    # Quantization applied
    quantization: Quantization = Quantization.NONE

    # Tensor parallel degree (for multi-GPU)
    tensor_parallel_size: int = 1

    # GPU memory utilization target (0.0 - 1.0)
    gpu_memory_utilization: float = 0.90

    # Whether this model fits fully in VRAM (vs quantized)
    fits_fully: bool = True

    # Additional vLLM engine kwargs
    extra_engine_args: Dict[str, object] = field(default_factory=dict)

    # Speed tier for display purposes
    @property
    def speed_tier(self) -> str:
        if self.param_billions <= 8:
            return "Very fast"
        elif self.param_billions <= 14:
            return "Fast"
        else:
            return "Moderate"


class ModelID(enum.Enum):
    """Identifiers for supported models."""
    MISTRAL_7B = "mistral-7b"
    LLAMA3_8B = "llama3-8b"
    QWEN25_14B = "qwen2.5-14b"
    LLAMA3_70B_Q4 = "llama3-70b-q4"
    DEEPSEEK_CODER_33B = "deepseek-coder-33b"


# ============================================================================
# Model Registry
# ============================================================================

MODELS: Dict[ModelID, ModelConfig] = {
    ModelID.MISTRAL_7B: ModelConfig(
        name="Mistral 7B",
        model_id="mistralai/Mistral-7B-Instruct-v0.3",
        param_billions=7,
        vram_gb=5,
        max_model_len=8192,
        quantization=Quantization.NONE,
        fits_fully=True,
    ),
    ModelID.LLAMA3_8B: ModelConfig(
        name="LLaMA 3 8B",
        model_id="meta-llama/Meta-Llama-3-8B-Instruct",
        param_billions=8,
        vram_gb=6,
        max_model_len=8192,
        quantization=Quantization.NONE,
        fits_fully=True,
    ),
    ModelID.QWEN25_14B: ModelConfig(
        name="Qwen 2.5 14B",
        model_id="Qwen/Qwen2.5-14B-Instruct",
        param_billions=14,
        vram_gb=10,
        max_model_len=8192,
        quantization=Quantization.NONE,
        fits_fully=True,
    ),
    ModelID.LLAMA3_70B_Q4: ModelConfig(
        name="LLaMA 3 70B (Q4)",
        model_id="meta-llama/Meta-Llama-3-70B-Instruct-AWQ",
        param_billions=70,
        vram_gb=20,
        max_model_len=4096,
        quantization=Quantization.AWQ,
        fits_fully=False,
    ),
    ModelID.DEEPSEEK_CODER_33B: ModelConfig(
        name="DeepSeek Coder 33B",
        model_id="deepseek-ai/deepseek-coder-33b-instruct",
        param_billions=33,
        vram_gb=19,
        max_model_len=4096,
        quantization=Quantization.AWQ,
        fits_fully=False,
        extra_engine_args={"trust_remote_code": True},
    ),
}

# Default model when none is specified
DEFAULT_MODEL = ModelID.LLAMA3_8B


def get_model(model_id: str) -> ModelConfig:
    """Look up a model by its string ID.

    Args:
        model_id: String identifier, e.g. "llama3-8b".

    Returns:
        The corresponding ModelConfig.

    Raises:
        ValueError: If model_id is not found.
    """
    try:
        key = ModelID(model_id)
    except ValueError:
        valid = ", ".join(m.value for m in ModelID)
        raise ValueError(
            f"Unknown model '{model_id}'. Valid models: {valid}"
        )
    return MODELS[key]


def list_models() -> Dict[str, Dict[str, object]]:
    """Return a summary dict of all available models for API responses."""
    result: Dict[str, Dict[str, object]] = {}
    for mid, cfg in MODELS.items():
        result[mid.value] = {
            "name": cfg.name,
            "model_id": cfg.model_id,
            "param_billions": cfg.param_billions,
            "vram_gb": cfg.vram_gb,
            "speed_tier": cfg.speed_tier,
            "quantization": cfg.quantization.value,
            "fits_fully": cfg.fits_fully,
            "max_model_len": cfg.max_model_len,
        }
    return result
