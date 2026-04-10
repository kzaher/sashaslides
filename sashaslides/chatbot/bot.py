"""SashaSlides Chat Bot — core state machine and message handling.

The bot follows this workflow per thread:
  1. AWAITING_LINK   — Ask user for a presentation link
  2. AWAITING_REQUEST — Ask for slide number or content description
  3. AWAITING_SELECTION — Show 4 suggestions, wait for pick (1-4)
  4. Apply selected slide → go back to step 2

All data flows through protobufs and is persisted to the database.
The bot communicates through an abstract ChatInterface, allowing
different platform implementations (Google Chat, Discord, mock CLI).
"""

import enum
import re
import time
from typing import Dict, List, Optional, Protocol

from proto import sashaslides_pb2
from sashaslides.composer.claude_client import ClaudeClient
from sashaslides.db.database import Database


# ============================================================================
# Chat interface protocol
# ============================================================================


class ChatInterface(Protocol):
    """Abstract interface for sending messages to a chat platform."""

    def send_message(self, thread_id: str, message: str) -> None:
        """Send a text message to the thread."""
        ...

    def send_slide_previews(
        self,
        thread_id: str,
        candidates: List[sashaslides_pb2.SlideCandidate],
    ) -> None:
        """Send slide preview cards to the thread."""
        ...


# ============================================================================
# Thread state machine
# ============================================================================


class ThreadState(enum.Enum):
    """State of an active bot thread."""

    AWAITING_LINK = "awaiting_link"
    AWAITING_REQUEST = "awaiting_request"
    AWAITING_SELECTION = "awaiting_selection"


# ============================================================================
# Bot personality messages (funny Eastern European accent)
# ============================================================================

WELCOME_MESSAGE = (
    "🐻 Privet, comrade! I am SashaSlides bot!\n"
    "I make your presentashun look like million rubles, da!\n\n"
    "Please share link to your Google Slides presentashun "
    "and we begin the magik! ✨"
)

LINK_RECEIVED_MESSAGE = (
    "🎉 Spasibo! I see your beautifool presentashun!\n"
    "Now tell me, what you want?\n\n"
    "• Send slide number (like `3`) to improve existing slide\n"
    "• Or describe what new slide should be about\n\n"
    "I generate 4 amazing suggestshuns for you! 💪"
)

SELECTION_MESSAGE = (
    "Here are 4 fantastik suggestshuns, comrade!\n"
    "Each one more beautifool than previous!\n"
    "Pick number 1-4! 🎨"
)

SLIDE_APPLIED_MESSAGE = (
    "✅ Otlichno! Slide has been applied to your presentashun!\n"
    "Is looking very profeshunal, da!\n\n"
    "Want to make another slide? Tell me slide number or describe new "
    "content!\nSashaSlides never sleeps! 🐻💤... just kidding, always "
    "awake for you!"
)

INVALID_SELECTION_MESSAGE = (
    "Hmm, I not understand this number. Please pick 1, 2, 3, or 4, da? 🤔"
)

NOT_A_LINK_MESSAGE = (
    "This not look like presentashun link, comrade! 🧐\n"
    "Please share Google Slides link.\n"
    "Should have docs.google.com or slides.google.com in it!"
)

GOODBYE_MESSAGE = "Do svidaniya, comrade! 👋🐻"

# Regex for detecting Google Slides URLs
_SLIDES_URL_RE = re.compile(
    r"https?://(?:docs|slides)\.google\.com/presentation/d/[\w-]+"
)


# ============================================================================
# Bot
# ============================================================================


class Bot:
    """SashaSlides chatbot with state machine workflow.

    One Bot instance handles all threads across a single chat platform.
    Each thread progresses through the state machine independently.
    """

    def __init__(
        self,
        db: Database,
        composer: ClaudeClient,
        chat: ChatInterface,
        platform: "sashaslides_pb2.ChatPlatform.ValueType" = (
            sashaslides_pb2.CHAT_PLATFORM_GOOGLE
        ),
    ) -> None:
        self._db = db
        self._composer = composer
        self._chat = chat
        self._platform = platform
        self._thread_states: Dict[str, ThreadState] = {}
        self._pending_candidates: Dict[
            str, List[sashaslides_pb2.SlideCandidate]
        ] = {}

    def handle_message(
        self,
        thread_external_id: str,
        user_id: str,
        message: str,
    ) -> None:
        """Handle an incoming message from a user.

        This is the main entry point. Routes to the appropriate handler
        based on the current thread state.
        """
        state = self._thread_states.get(thread_external_id)

        if state is None:
            self._start_thread(thread_external_id, user_id)
            return

        if state == ThreadState.AWAITING_LINK:
            self._handle_link(thread_external_id, message)
        elif state == ThreadState.AWAITING_REQUEST:
            self._handle_request(thread_external_id, message)
        elif state == ThreadState.AWAITING_SELECTION:
            self._handle_selection(thread_external_id, message)

    def get_thread_state(
        self, thread_external_id: str
    ) -> Optional[ThreadState]:
        """Get the current state of a thread (for testing)."""
        return self._thread_states.get(thread_external_id)

    # ---------------------------------------------------------------- states

    def _start_thread(
        self, thread_external_id: str, user_id: str
    ) -> None:
        """Initialize a new thread and ask for presentation link."""
        thread = sashaslides_pb2.Thread(
            thread_external_id=thread_external_id,
            chat_platform=self._platform,
            slides_platform=sashaslides_pb2.SLIDES_PLATFORM_GOOGLE,
            user_id=user_id,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread(thread)
        self._thread_states[thread_external_id] = ThreadState.AWAITING_LINK
        self._chat.send_message(thread_external_id, WELCOME_MESSAGE)

    def _handle_link(
        self, thread_external_id: str, message: str
    ) -> None:
        """Process a presentation link from the user."""
        match = _SLIDES_URL_RE.search(message)
        if not match:
            self._chat.send_message(
                thread_external_id, NOT_A_LINK_MESSAGE
            )
            return

        url = match.group(0)
        result = self._db.get_thread_by_external_id(thread_external_id)
        if not result:
            return

        thread_id, thread = result
        thread.presentation_url = url
        self._db.update_thread(thread_id, thread)

        # Record action
        action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_LINK_SHARED,
            user_message=message,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread_action(action)

        self._thread_states[thread_external_id] = (
            ThreadState.AWAITING_REQUEST
        )
        self._chat.send_message(
            thread_external_id, LINK_RECEIVED_MESSAGE
        )

    def _handle_request(
        self, thread_external_id: str, message: str
    ) -> None:
        """Process a slide generation request (number or content)."""
        result = self._db.get_thread_by_external_id(thread_external_id)
        if not result:
            return

        thread_id, thread = result

        # Determine if user sent a slide number or content description
        slide_number = 0
        user_prompt = message.strip()
        try:
            slide_number = int(message.strip())
            user_prompt = f"Improve slide number {slide_number}"
        except ValueError:
            pass

        # Build generation request
        gen_request = sashaslides_pb2.GenerateSlideRequest(
            presentation_url=thread.presentation_url,
            slide_number=slide_number,
            user_prompt=user_prompt,
        )

        # Get suggestions from Composer
        gen_response = self._composer.generate_slide_suggestions(gen_request)

        # Record the generation request action
        action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST,
            user_message=message,
            target_slide_number=slide_number,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread_action(action)

        # Store slide contents
        content_ids: List[int] = []
        for i, candidate in enumerate(gen_response.candidates):
            content = sashaslides_pb2.SlideContent(
                thread_id=thread_id,
                content_json=candidate.content_json,
                suggestion_index=i + 1,
                created_at_unix=int(time.time()),
            )
            content_id = self._db.create_slide_content(content)
            content_ids.append(content_id)

        # Record the suggestions action
        suggestions_action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_SUGGESTIONS_GENERATED,
            slide_content_ids=content_ids,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread_action(suggestions_action)

        # Send to user
        self._pending_candidates[thread_external_id] = list(
            gen_response.candidates
        )
        self._chat.send_message(thread_external_id, SELECTION_MESSAGE)
        self._chat.send_slide_previews(
            thread_external_id, list(gen_response.candidates)
        )
        self._thread_states[thread_external_id] = (
            ThreadState.AWAITING_SELECTION
        )

    def _handle_selection(
        self, thread_external_id: str, message: str
    ) -> None:
        """Process the user's selection of a slide suggestion (1-4)."""
        try:
            selection = int(message.strip())
            if selection < 1 or selection > 4:
                raise ValueError("Selection out of range")
        except ValueError:
            self._chat.send_message(
                thread_external_id, INVALID_SELECTION_MESSAGE
            )
            return

        result = self._db.get_thread_by_external_id(thread_external_id)
        if not result:
            return

        thread_id, _thread = result

        # Record selection
        select_action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_SUGGESTION_SELECTED,
            selected_suggestion=selection,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread_action(select_action)

        # TODO: Actually import the slide into Google Slides via API
        # For now, just record that we would have imported it
        import_action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_SLIDE_IMPORTED,
            selected_suggestion=selection,
            created_at_unix=int(time.time()),
        )
        self._db.create_thread_action(import_action)

        # Clear pending candidates
        self._pending_candidates.pop(thread_external_id, None)

        self._thread_states[thread_external_id] = (
            ThreadState.AWAITING_REQUEST
        )
        self._chat.send_message(
            thread_external_id, SLIDE_APPLIED_MESSAGE
        )
