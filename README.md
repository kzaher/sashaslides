# SashaSlides 🐻

> AI-powered presentashun slide generator — like Midjourney, but for slides, da!

SashaSlides is a chatbot that generates presentation slides through a conversational interface. Share a Google Slides link, describe the slide you want (or pick one to improve), and Sasha generates 4 suggestions. Pick your favourite and it's imported straight into your presentation.

# Tone

* The tone is funny and humorous. You can intentionally write misspellings to convey easter european accent.

## Claude Composer — Direct Slide Editing (NEW)

We are adding a new component to SashaSlides: **direct editing of presentashuns** using Claude! Instead of just generating slide content through chat, Claude Composer lets you edit slides hands-on — like having tiny AI artist living inside your presentashun, da!

The idea is simple but powerful:
1. You give markdown describing your slides
2. Composer finds the closest matching template slide from past presentashuns
3. It adapts the template to your content using Google Slides API
4. You see screenshot of result and iterate until is looking fantastik!

This is a TypeScript project living in `sashaslides/claude-composer/` with Chrome-based visual verificashun. Think of it as the "art studio" where slides get sculpted directly.

See [`sashaslides/claude-composer/README.md`](sashaslides/claude-composer/README.md) for the full details, comrade!

## How It Works

```
You:    https://docs.google.com/presentation/d/abc123/edit
Sasha:  Spasibo! I see your beautifool presentashun! What you want?
You:    Make a slide about Q4 revenue growth
Sasha:  Here are 4 fantastik suggestshuns! Pick 1-4, comrade! 🎨
You:    2
Sasha:  ✅ Slide applied! Is looking very profeshunal, da!
```

The bot loops: after each slide is applied it asks for the next request.

## Architecture

```
┌────────────┐       ┌────────────┐       ┌─────────────┐
│  Chat Bot  │──────>│  Composer   │──────>│ Claude Haiku│
│ (state     │       │ (Flask      │       │ (AI slide   │
│  machine)  │<──────│  server)    │<──────│  generation)│
└─────┬──────┘       └────────────┘       └─────────────┘
      │
      v
┌────────────┐
│   SQLite   │
│  Database  │
└────────────┘
```

| Component | Description |
|-----------|-------------|
| **Chat Bot** | State machine per thread: `AWAITING_LINK` → `AWAITING_REQUEST` → `AWAITING_SELECTION` → loop. Communicates through an abstract `ChatInterface` (Google Chat, Discord, or mock CLI). |
| **Composer** | Flask server (`POST /generate`) that takes a `GenerateSlideRequest` protobuf and returns 4 `SlideCandidate`s. Backed by Claude Haiku (stub mode available). |
| **Database** | SQLite with three tables (`threads`, `slide_contents`, `thread_actions`). All rows store JSON-serialized protobufs — no raw JSON is ever parsed manually. |
| **Website** | Static landing page for [SashaSlides.com](https://sashaslides.com) explaining the workflow and linking to the Google Chat bot. Served by nginx. |

All data flows through **Protocol Buffers** defined in [proto/sashaslides.proto](proto/sashaslides.proto). Slide content follows the [Google Slides API Page resource](https://developers.google.com/slides/api/reference/rest/v1/presentations.pages) format.

## Project Structure

```
├── proto/
│   └── sashaslides.proto        # Protobuf definitions (all data models)
├── sashaslides/
│   ├── chatbot/
│   │   ├── bot.py               # Core bot state machine
│   │   ├── bot_test.py          # Bot tests
│   │   └── mock_interface.py    # CLI mock for local testing
│   ├── composer/
│   │   ├── server.py            # Flask API server
│   │   ├── server_test.py       # Server tests
│   │   └── claude_client.py     # Claude Haiku client (stub + real)
│   └── db/
│       ├── database.py          # SQLite database layer
│       └── database_test.py     # Database tests
├── website/
│   ├── index.html               # Landing page
│   └── style.css                # Styles
├── scripts/
│   └── generate_protos.sh       # Proto codegen (non-Bazel)
├── BUILD                        # Root Bazel BUILD file
├── WORKSPACE                    # Bazel workspace config
├── Dockerfile                   # Production container
├── docker-compose.yml           # Full system orchestration
├── pyproject.toml               # Python tooling config
└── requirements.txt             # Python dependencies
```

## Getting Started

### Prerequisites

- Docker & Docker Compose **or** Bazelisk
- Python 3.11+ (if running outside containers)
- (Optional) Anthropic API key for real Claude Haiku generation

### Quick Start with Docker Compose

```bash
# Start all services (composer, chatbot, website)
docker compose up -d

# Check composer health
curl http://localhost:8080/health

# View the landing page
open http://localhost:8090

# Interact with the mock chatbot
docker compose attach chatbot
```

### Quick Start with Bazel

```bash
# Run all tests
bazel test //...

# Start the Composer server
bazel run //sashaslides/composer:server

# Start the mock chatbot CLI
bazel run //sashaslides/chatbot:mock_interface
```

### Local Development (without Bazel)

```bash
# Install dependencies
pip install -r requirements.txt

# Generate protobuf code
./scripts/generate_protos.sh

# Run the Composer server
python -m sashaslides.composer.server

# Run the mock chatbot (in another terminal)
python -m sashaslides.chatbot.mock_interface

# Run tests
pytest
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ANTHROPIC_API_KEY` | `stub` | Anthropic API key. Set to `stub` or leave unset for stub mode (deterministic responses). |
| `COMPOSER_PORT` | `8080` | Port for the Composer Flask server. |
| `COMPOSER_URL` | `http://composer:8080` | Composer URL used by the chatbot service. |
| `DB_PATH` | `:memory:` | SQLite database file path. Use `:memory:` for ephemeral storage. |
| `FLASK_DEBUG` | `false` | Enable Flask debug mode. |

## Services

### Composer Server

The Composer exposes these endpoints:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service info and stub mode status |
| `GET` | `/health` | Health check |
| `POST` | `/generate` | Generate 4 slide suggestions from a `GenerateSlideRequest` JSON protobuf |

**Example request:**

```bash
curl -X POST http://localhost:8080/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "presentation_url": "https://docs.google.com/presentation/d/abc123/edit",
    "slide_number": 0,
    "user_prompt": "Q4 revenue growth"
  }'
```

### Chat Bot

The bot runs a per-thread state machine:

1. **AWAITING_LINK** — Greets the user and asks for a Google Slides link.
2. **AWAITING_REQUEST** — Asks for a slide number (to improve) or content description (for a new slide).
3. **AWAITING_SELECTION** — Displays 4 slide suggestions; waits for the user to pick 1–4.
4. Applies the selected slide and loops back to step 2.

The bot uses an abstract `ChatInterface` protocol, making it easy to plug in different platforms (Google Chat, Discord, etc.). A `MockChatInterface` is provided for local CLI testing.

## Data Model

All data is defined as protobufs in [proto/sashaslides.proto](proto/sashaslides.proto):

- **`Thread`** — A conversation thread (external ID, platform, presentation URL, user).
- **`SlideContent`** — A single slide suggestion's content (stored separately, referenced by ID).
- **`ThreadAction`** — An action within a thread (link shared, generation requested, suggestions generated, suggestion selected, slide imported).
- **`GenerateSlideRequest` / `GenerateSlideResponse`** — Composer service messages.

### Database Schema

```
threads
  ├── id (autoincrement PK)
  ├── thread_external_id (indexed)
  ├── chat_platform (indexed)
  └── data (JSON-serialized Thread proto)

slide_contents
  ├── id (autoincrement PK)
  ├── thread_id (FK → threads, indexed)
  └── data (JSON-serialized SlideContent proto)

thread_actions
  ├── id (autoincrement PK)
  ├── thread_id (FK → threads, indexed)
  ├── action_type (indexed)
  └── data (JSON-serialized ThreadAction proto)
```

### Supported Platforms

| Chat Platform | Slides Platform |
|--------------|-----------------|
| Google Chat | Google Slides |
| Microsoft Teams | Microsoft PowerPoint |
| Discord | — |

## Testing

```bash
# Bazel
bazel test //...

# pytest
pytest

# Individual test targets
bazel test //sashaslides/chatbot:bot_test
bazel test //sashaslides/composer:server_test
bazel test //sashaslides/db:database_test
```

## Tech Stack

- **Language:** Python 3.11
- **Build System:** Bazel (via Bazelisk)
- **Data Serialization:** Protocol Buffers
- **Web Framework:** Flask
- **AI Backend:** Claude Haiku (Anthropic)
- **Database:** SQLite (WAL mode)
- **Type Checking:** mypy (strict mode)
- **Formatting:** Black
- **Containerization:** Docker, Docker Compose
- **Dev Environment:** VS Code Dev Containers
- **Website:** Static HTML/CSS served by nginx

## Website

The landing page at [SashaSlides.com](https://sashaslides.com) explains the workflow and links directly to Google Chat to start a conversation with the bot. Served as a static site via nginx on port 8090.

## License

All rights reserved, comrade! 🐻