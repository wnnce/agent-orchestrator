import React from "react";
import { useStudio } from "../../context/StudioContext";
import { SessionConversation } from "../session/SessionConversation";
import { SessionBoard } from "../workspace/SessionBoard";

export function SessionsView() {
  const { activeSessionId } = useStudio();

  if (!activeSessionId) {
    return <SessionBoard />;
  }

  return <SessionConversation sessionId={activeSessionId} />;
}
