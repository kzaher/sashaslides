"""SQLite database for SashaSlides with protobuf-based data model.

Every table follows the pattern:
  - id: INTEGER PRIMARY KEY AUTOINCREMENT (always ascending)
  - Indexing fields extracted from the proto for fast lookups
  - data: TEXT (JSON-serialized protobuf — all fields live here)

No raw JSON is ever parsed manually; everything goes through protobuf
json_format for serialization/deserialization.
"""

import sqlite3
import time
from typing import List, Optional, Tuple, Type, TypeVar

from google.protobuf import json_format
from google.protobuf.message import Message

from proto import sashaslides_pb2

T = TypeVar("T", bound=Message)


class Database:
    """SQLite database for SashaSlides."""

    def __init__(self, db_path: str = ":memory:") -> None:
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._create_tables()

    # ------------------------------------------------------------------ init

    def _create_tables(self) -> None:
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS threads (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_external_id TEXT NOT NULL,
                chat_platform TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_threads_ext_id
                ON threads(thread_external_id);
            CREATE INDEX IF NOT EXISTS idx_threads_platform
                ON threads(chat_platform);

            CREATE TABLE IF NOT EXISTS slide_contents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (thread_id) REFERENCES threads(id)
            );
            CREATE INDEX IF NOT EXISTS idx_slide_contents_thread
                ON slide_contents(thread_id);

            CREATE TABLE IF NOT EXISTS thread_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id INTEGER NOT NULL,
                action_type TEXT NOT NULL,
                data TEXT NOT NULL,
                FOREIGN KEY (thread_id) REFERENCES threads(id)
            );
            CREATE INDEX IF NOT EXISTS idx_actions_thread
                ON thread_actions(thread_id);
            CREATE INDEX IF NOT EXISTS idx_actions_type
                ON thread_actions(action_type);
            """
        )
        self._conn.commit()

    # --------------------------------------------------------- proto helpers

    @staticmethod
    def _proto_to_json(proto: Message) -> str:
        return json_format.MessageToJson(
            proto, preserving_proto_field_name=True
        )

    @staticmethod
    def _json_to_proto(json_str: str, proto_type: Type[T]) -> T:
        proto = proto_type()
        json_format.Parse(json_str, proto)
        return proto

    # -------------------------------------------------------------- threads

    def create_thread(self, thread: sashaslides_pb2.Thread) -> int:
        cursor = self._conn.execute(
            "INSERT INTO threads (thread_external_id, chat_platform, data) "
            "VALUES (?, ?, ?)",
            (
                thread.thread_external_id,
                sashaslides_pb2.ChatPlatform.Name(thread.chat_platform),
                self._proto_to_json(thread),
            ),
        )
        self._conn.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    def get_thread(self, thread_id: int) -> Optional[sashaslides_pb2.Thread]:
        cursor = self._conn.execute(
            "SELECT data FROM threads WHERE id = ?", (thread_id,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return self._json_to_proto(row["data"], sashaslides_pb2.Thread)

    def get_thread_by_external_id(
        self, external_id: str
    ) -> Optional[Tuple[int, sashaslides_pb2.Thread]]:
        cursor = self._conn.execute(
            "SELECT id, data FROM threads WHERE thread_external_id = ?",
            (external_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return row["id"], self._json_to_proto(
            row["data"], sashaslides_pb2.Thread
        )

    def update_thread(
        self, thread_id: int, thread: sashaslides_pb2.Thread
    ) -> None:
        self._conn.execute(
            "UPDATE threads SET data = ? WHERE id = ?",
            (self._proto_to_json(thread), thread_id),
        )
        self._conn.commit()

    # -------------------------------------------------------- slide contents

    def create_slide_content(
        self, content: sashaslides_pb2.SlideContent
    ) -> int:
        cursor = self._conn.execute(
            "INSERT INTO slide_contents (thread_id, data) VALUES (?, ?)",
            (content.thread_id, self._proto_to_json(content)),
        )
        self._conn.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    def get_slide_contents_for_thread(
        self, thread_id: int
    ) -> List[Tuple[int, sashaslides_pb2.SlideContent]]:
        cursor = self._conn.execute(
            "SELECT id, data FROM slide_contents "
            "WHERE thread_id = ? ORDER BY id",
            (thread_id,),
        )
        return [
            (
                row["id"],
                self._json_to_proto(
                    row["data"], sashaslides_pb2.SlideContent
                ),
            )
            for row in cursor.fetchall()
        ]

    def get_slide_content(
        self, content_id: int
    ) -> Optional[sashaslides_pb2.SlideContent]:
        cursor = self._conn.execute(
            "SELECT data FROM slide_contents WHERE id = ?", (content_id,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return self._json_to_proto(
            row["data"], sashaslides_pb2.SlideContent
        )

    # ------------------------------------------------------- thread actions

    def create_thread_action(
        self, action: sashaslides_pb2.ThreadAction
    ) -> int:
        cursor = self._conn.execute(
            "INSERT INTO thread_actions (thread_id, action_type, data) "
            "VALUES (?, ?, ?)",
            (
                action.thread_id,
                sashaslides_pb2.ActionType.Name(action.action_type),
                self._proto_to_json(action),
            ),
        )
        self._conn.commit()
        return cursor.lastrowid  # type: ignore[return-value]

    def get_actions_for_thread(
        self, thread_id: int
    ) -> List[Tuple[int, sashaslides_pb2.ThreadAction]]:
        cursor = self._conn.execute(
            "SELECT id, data FROM thread_actions "
            "WHERE thread_id = ? ORDER BY id",
            (thread_id,),
        )
        return [
            (
                row["id"],
                self._json_to_proto(
                    row["data"], sashaslides_pb2.ThreadAction
                ),
            )
            for row in cursor.fetchall()
        ]

    def get_actions_by_type(
        self, thread_id: int, action_type: "sashaslides_pb2.ActionType.ValueType"
    ) -> List[Tuple[int, sashaslides_pb2.ThreadAction]]:
        cursor = self._conn.execute(
            "SELECT id, data FROM thread_actions "
            "WHERE thread_id = ? AND action_type = ? ORDER BY id",
            (
                thread_id,
                sashaslides_pb2.ActionType.Name(action_type),
            ),
        )
        return [
            (
                row["id"],
                self._json_to_proto(
                    row["data"], sashaslides_pb2.ThreadAction
                ),
            )
            for row in cursor.fetchall()
        ]

    # ---------------------------------------------------------------- utils

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, *args: object) -> None:
        self.close()
