"""Mock chat interface for local CLI testing.

Simulates a chat platform by printing messages to stdout and
reading input from stdin. Useful for testing the bot workflow
without any external service dependencies.

Usage:
    python -m sashaslides.chatbot.mock_interface
    # or via Bazel:
    bazel run //sashaslides/chatbot:mock_interface
"""

import sys
from typing import List

from proto import sashaslides_pb2
from sashaslides.chatbot.bot import Bot, ChatInterface
from sashaslides.composer.claude_client import ClaudeClient
from sashaslides.db.database import Database


class MockChatInterface:
    """CLI-based mock chat interface that prints to stdout."""

    def send_message(self, thread_id: str, message: str) -> None:
        """Print a bot message to stdout."""
        print(f"\n{'=' * 60}")
        print(f"🤖 SashaSlides [{thread_id}]:")
        print(f"{'─' * 60}")
        print(message)
        print(f"{'=' * 60}")

    def send_slide_previews(
        self,
        thread_id: str,
        candidates: List[sashaslides_pb2.SlideCandidate],
    ) -> None:
        """Print slide preview cards to stdout."""
        print(f"\n{'─' * 60}")
        print("📊 SLIDE SUGGESTIONS:")
        print(f"{'─' * 60}")
        for i, candidate in enumerate(candidates, 1):
            print(f"\n  [{i}] {candidate.title}")
            print(f"      {candidate.description}")
            print(f"      (Content: {len(candidate.content_json)} bytes)")
        print(f"\n{'─' * 60}")
        print("Enter 1-4 to pick your favorite, comrade!")


def _print_banner() -> None:
    """Print the welcome banner."""
    print(
        r"""
   ____            _           ____  _ _     _
  / ___|  __ _ ___| |__   __ / ___|| (_) __| | ___  ___
  \___ \ / _` / __| '_ \ / _` \___ \| | |/ _` |/ _ \/ __|
   ___) | (_| \__ \ | | | (_| |___) | | | (_| |  __/\__ \
  |____/ \__,_|___/_| |_|\__,_|____/|_|_|\__,_|\___||___/

  🐻 Mock Chat Interface — for testing without Google Chat
  Type 'quit' or 'exit' to leave. Ctrl+C also works, da!
"""
    )


def main() -> None:
    """Run the mock chat interface."""
    _print_banner()

    db = Database(":memory:")
    composer = ClaudeClient()
    interface = MockChatInterface()
    bot = Bot(
        db=db,
        composer=composer,
        chat=interface,
        platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
    )

    thread_id = "mock_thread_1"
    user_id = "mock_user"

    # Trigger the welcome message
    bot.handle_message(thread_id, user_id, "/start")

    while True:
        try:
            user_input = input("\nYou > ").strip()
            if not user_input:
                continue
            if user_input.lower() in ("quit", "exit", "/quit", "/exit"):
                print("\n🐻 Do svidaniya, comrade! 👋")
                break
            bot.handle_message(thread_id, user_id, user_input)
        except (EOFError, KeyboardInterrupt):
            print("\n\n🐻 Do svidaniya, comrade! 👋")
            break

    db.close()


if __name__ == "__main__":
    main()
