"""Tests for the SashaSlides chatbot."""

import unittest
from typing import Dict, List, Tuple

from proto import sashaslides_pb2
from sashaslides.chatbot.bot import (
    Bot,
    ThreadState,
    WELCOME_MESSAGE,
    LINK_RECEIVED_MESSAGE,
    SELECTION_MESSAGE,
    SLIDE_APPLIED_MESSAGE,
    INVALID_SELECTION_MESSAGE,
    NOT_A_LINK_MESSAGE,
)
from sashaslides.composer.claude_client import ClaudeClient
from sashaslides.db.database import Database


class FakeChatInterface:
    """Test double that records all sent messages."""

    def __init__(self) -> None:
        self.messages: List[Tuple[str, str]] = []
        self.previews: List[
            Tuple[str, List[sashaslides_pb2.SlideCandidate]]
        ] = []

    def send_message(self, thread_id: str, message: str) -> None:
        self.messages.append((thread_id, message))

    def send_slide_previews(
        self,
        thread_id: str,
        candidates: List[sashaslides_pb2.SlideCandidate],
    ) -> None:
        self.previews.append((thread_id, candidates))

    @property
    def last_message(self) -> str:
        return self.messages[-1][1] if self.messages else ""

    def clear(self) -> None:
        self.messages.clear()
        self.previews.clear()


class TestBot(unittest.TestCase):
    """Tests for the bot state machine."""

    def setUp(self) -> None:
        self.db = Database(":memory:")
        self.composer = ClaudeClient()
        self.chat = FakeChatInterface()
        self.bot = Bot(
            db=self.db,
            composer=self.composer,
            chat=self.chat,
            platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
        )
        self.thread_id = "test_thread_1"
        self.user_id = "test_user"

    def tearDown(self) -> None:
        self.db.close()

    # --------------------------------------------------- initial state

    def test_new_thread_sends_welcome(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.assertEqual(self.chat.last_message, WELCOME_MESSAGE)

    def test_new_thread_state_is_awaiting_link(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_LINK,
        )

    def test_new_thread_creates_db_record(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        result = self.db.get_thread_by_external_id(self.thread_id)
        self.assertIsNotNone(result)

    # --------------------------------------------------- link handling

    def test_valid_link_transitions_to_awaiting_request(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.bot.handle_message(
            self.thread_id,
            self.user_id,
            "https://docs.google.com/presentation/d/abc123/edit",
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )
        self.assertEqual(self.chat.last_message, LINK_RECEIVED_MESSAGE)

    def test_invalid_link_stays_awaiting_link(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.bot.handle_message(
            self.thread_id, self.user_id, "this is not a link"
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_LINK,
        )
        self.assertEqual(self.chat.last_message, NOT_A_LINK_MESSAGE)

    def test_link_stored_in_database(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        url = "https://docs.google.com/presentation/d/xyz789/edit"
        self.bot.handle_message(self.thread_id, self.user_id, url)

        result = self.db.get_thread_by_external_id(self.thread_id)
        assert result is not None
        _, thread = result
        self.assertIn("xyz789", thread.presentation_url)

    def test_link_with_slides_subdomain(self) -> None:
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.bot.handle_message(
            self.thread_id,
            self.user_id,
            "Check out https://slides.google.com/presentation/d/test123",
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )

    # --------------------------------------------------- request handling

    def _setup_ready_for_request(self) -> None:
        """Helper: set up bot in AWAITING_REQUEST state."""
        self.bot.handle_message(self.thread_id, self.user_id, "/start")
        self.bot.handle_message(
            self.thread_id,
            self.user_id,
            "https://docs.google.com/presentation/d/abc123/edit",
        )
        self.chat.clear()

    def test_content_request_generates_suggestions(self) -> None:
        self._setup_ready_for_request()
        self.bot.handle_message(
            self.thread_id,
            self.user_id,
            "Make a slide about machine learning",
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )
        self.assertIn(SELECTION_MESSAGE, self.chat.last_message)

    def test_slide_number_request(self) -> None:
        self._setup_ready_for_request()
        self.bot.handle_message(self.thread_id, self.user_id, "3")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )

    def test_four_previews_sent(self) -> None:
        self._setup_ready_for_request()
        self.bot.handle_message(
            self.thread_id, self.user_id, "Company overview"
        )
        self.assertEqual(len(self.chat.previews), 1)
        _, candidates = self.chat.previews[0]
        self.assertEqual(len(candidates), 4)

    def test_slide_contents_stored_in_db(self) -> None:
        self._setup_ready_for_request()
        self.bot.handle_message(
            self.thread_id, self.user_id, "Revenue chart"
        )
        result = self.db.get_thread_by_external_id(self.thread_id)
        assert result is not None
        thread_id, _ = result
        contents = self.db.get_slide_contents_for_thread(thread_id)
        self.assertEqual(len(contents), 4)

    # -------------------------------------------------- selection handling

    def _setup_ready_for_selection(self) -> None:
        """Helper: set up bot in AWAITING_SELECTION state."""
        self._setup_ready_for_request()
        self.bot.handle_message(
            self.thread_id, self.user_id, "Test slide"
        )
        self.chat.clear()

    def test_valid_selection_applies_slide(self) -> None:
        self._setup_ready_for_selection()
        self.bot.handle_message(self.thread_id, self.user_id, "2")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )
        self.assertEqual(self.chat.last_message, SLIDE_APPLIED_MESSAGE)

    def test_invalid_selection_stays_in_state(self) -> None:
        self._setup_ready_for_selection()
        self.bot.handle_message(self.thread_id, self.user_id, "7")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )
        self.assertEqual(
            self.chat.last_message, INVALID_SELECTION_MESSAGE
        )

    def test_non_numeric_selection_rejected(self) -> None:
        self._setup_ready_for_selection()
        self.bot.handle_message(
            self.thread_id, self.user_id, "banana"
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )

    def test_selection_records_actions_in_db(self) -> None:
        self._setup_ready_for_selection()
        self.bot.handle_message(self.thread_id, self.user_id, "1")

        result = self.db.get_thread_by_external_id(self.thread_id)
        assert result is not None
        thread_id, _ = result

        select_actions = self.db.get_actions_by_type(
            thread_id,
            sashaslides_pb2.ACTION_TYPE_SUGGESTION_SELECTED,
        )
        self.assertEqual(len(select_actions), 1)
        self.assertEqual(select_actions[0][1].selected_suggestion, 1)

        import_actions = self.db.get_actions_by_type(
            thread_id,
            sashaslides_pb2.ACTION_TYPE_SLIDE_IMPORTED,
        )
        self.assertEqual(len(import_actions), 1)

    # --------------------------------------------------- full workflow loop

    def test_full_workflow_loop(self) -> None:
        """Test the complete workflow: link → request → select → repeat."""
        self.bot.handle_message(self.thread_id, self.user_id, "/start")

        # Step 1: Share link
        self.bot.handle_message(
            self.thread_id,
            self.user_id,
            "https://docs.google.com/presentation/d/loop_test/edit",
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )

        # Step 2: Request slide
        self.bot.handle_message(
            self.thread_id, self.user_id, "Intro slide"
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )

        # Step 3: Pick suggestion
        self.bot.handle_message(self.thread_id, self.user_id, "3")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )

        # Step 4: Another request (loop back)
        self.bot.handle_message(
            self.thread_id, self.user_id, "Conclusion slide"
        )
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_SELECTION,
        )

        # Step 5: Pick again
        self.bot.handle_message(self.thread_id, self.user_id, "1")
        self.assertEqual(
            self.bot.get_thread_state(self.thread_id),
            ThreadState.AWAITING_REQUEST,
        )

    # ------------------------------------------------- multiple threads

    def test_multiple_threads_independent(self) -> None:
        """Two threads should have independent state."""
        thread_a = "thread_a"
        thread_b = "thread_b"

        self.bot.handle_message(thread_a, "user_a", "/start")
        self.bot.handle_message(thread_b, "user_b", "/start")

        self.bot.handle_message(
            thread_a,
            "user_a",
            "https://docs.google.com/presentation/d/a123/edit",
        )

        # Thread A moved forward, thread B still awaiting link
        self.assertEqual(
            self.bot.get_thread_state(thread_a),
            ThreadState.AWAITING_REQUEST,
        )
        self.assertEqual(
            self.bot.get_thread_state(thread_b),
            ThreadState.AWAITING_LINK,
        )


if __name__ == "__main__":
    unittest.main()
