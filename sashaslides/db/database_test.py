"""Tests for the SashaSlides database layer."""

import time
import unittest

from proto import sashaslides_pb2
from sashaslides.db.database import Database


class TestDatabase(unittest.TestCase):
    """Tests for Database CRUD operations using in-memory SQLite."""

    def setUp(self) -> None:
        self.db = Database(":memory:")

    def tearDown(self) -> None:
        self.db.close()

    # ----------------------------------------------------------- threads

    def test_create_and_get_thread(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_123",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            slides_platform=sashaslides_pb2.SLIDES_PLATFORM_GOOGLE,
            presentation_url="https://docs.google.com/presentation/d/abc",
            user_id="user_1",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)
        self.assertGreater(thread_id, 0)

        retrieved = self.db.get_thread(thread_id)
        self.assertIsNotNone(retrieved)
        assert retrieved is not None
        self.assertEqual(retrieved.thread_external_id, "ext_123")
        self.assertEqual(
            retrieved.chat_platform, sashaslides_pb2.CHAT_PLATFORM_GOOGLE
        )
        self.assertEqual(
            retrieved.presentation_url,
            "https://docs.google.com/presentation/d/abc",
        )

    def test_get_thread_not_found(self) -> None:
        self.assertIsNone(self.db.get_thread(999))

    def test_get_thread_by_external_id(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_456",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_DISCORD,
            user_id="user_2",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        self.db.create_thread(thread)

        result = self.db.get_thread_by_external_id("ext_456")
        self.assertIsNotNone(result)
        assert result is not None
        tid, t = result
        self.assertEqual(t.thread_external_id, "ext_456")
        self.assertEqual(
            t.chat_platform, sashaslides_pb2.CHAT_PLATFORM_DISCORD
        )

    def test_get_thread_by_external_id_not_found(self) -> None:
        self.assertIsNone(self.db.get_thread_by_external_id("nonexistent"))

    def test_update_thread(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_789",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            user_id="user_3",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)

        thread.presentation_url = "https://docs.google.com/presentation/d/xyz"
        self.db.update_thread(thread_id, thread)

        updated = self.db.get_thread(thread_id)
        assert updated is not None
        self.assertEqual(
            updated.presentation_url,
            "https://docs.google.com/presentation/d/xyz",
        )

    # ---------------------------------------------------- slide contents

    def test_create_and_get_slide_contents(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_sc",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            user_id="user_sc",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)

        for i in range(4):
            content = sashaslides_pb2.SlideContent(
                thread_id=thread_id,
                content_json=f'{{"slide": {i}}}',
                suggestion_index=i + 1,
                created_at_unix_milliseconds=int(time.time() * 1000),
            )
            self.db.create_slide_content(content)

        contents = self.db.get_slide_contents_for_thread(thread_id)
        self.assertEqual(len(contents), 4)
        for idx, (cid, c) in enumerate(contents):
            self.assertEqual(c.suggestion_index, idx + 1)
            self.assertGreater(cid, 0)

    def test_get_slide_content_by_id(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_sc2",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            user_id="user_sc2",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)

        content = sashaslides_pb2.SlideContent(
            thread_id=thread_id,
            content_json='{"test": true}',
            suggestion_index=1,
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        content_id = self.db.create_slide_content(content)

        retrieved = self.db.get_slide_content(content_id)
        self.assertIsNotNone(retrieved)
        assert retrieved is not None
        self.assertEqual(retrieved.content_json, '{"test": true}')

    # --------------------------------------------------- thread actions

    def test_create_and_get_actions(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_act",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            user_id="user_act",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)

        link_action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_LINK_SHARED,
            user_message="https://docs.google.com/presentation/d/test",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        self.db.create_thread_action(link_action)

        gen_action = sashaslides_pb2.ThreadAction(
            thread_id=thread_id,
            action_type=sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST,
            user_message="Make a slide about bears",
            target_slide_number=0,
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        self.db.create_thread_action(gen_action)

        actions = self.db.get_actions_for_thread(thread_id)
        self.assertEqual(len(actions), 2)
        self.assertEqual(
            actions[0][1].action_type,
            sashaslides_pb2.ACTION_TYPE_LINK_SHARED,
        )
        self.assertEqual(
            actions[1][1].action_type,
            sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST,
        )

    def test_get_actions_by_type(self) -> None:
        thread = sashaslides_pb2.Thread(
            thread_external_id="ext_abt",
            chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
            user_id="user_abt",
            created_at_unix_milliseconds=int(time.time() * 1000),
        )
        thread_id = self.db.create_thread(thread)

        for action_type in [
            sashaslides_pb2.ACTION_TYPE_LINK_SHARED,
            sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST,
            sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST,
        ]:
            action = sashaslides_pb2.ThreadAction(
                thread_id=thread_id,
                action_type=action_type,
                created_at_unix_milliseconds=int(time.time() * 1000),
            )
            self.db.create_thread_action(action)

        gen_actions = self.db.get_actions_by_type(
            thread_id, sashaslides_pb2.ACTION_TYPE_GENERATE_REQUEST
        )
        self.assertEqual(len(gen_actions), 2)

    # -------------------------------------------------------- context mgr

    def test_context_manager(self) -> None:
        with Database(":memory:") as db:
            thread = sashaslides_pb2.Thread(
                thread_external_id="ctx_test",
                chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
                user_id="user_ctx",
                created_at_unix_milliseconds=int(time.time() * 1000),
            )
            tid = db.create_thread(thread)
            self.assertGreater(tid, 0)

    # ---------------------------------------- IDs always ascending

    def test_ids_always_ascending(self) -> None:
        prev_id = 0
        for i in range(5):
            thread = sashaslides_pb2.Thread(
                thread_external_id=f"asc_{i}",
                chat_platform=sashaslides_pb2.CHAT_PLATFORM_GOOGLE,
                user_id=f"user_{i}",
                created_at_unix_milliseconds=int(time.time() * 1000),
            )
            tid = self.db.create_thread(thread)
            self.assertGreater(tid, prev_id)
            prev_id = tid


if __name__ == "__main__":
    unittest.main()
