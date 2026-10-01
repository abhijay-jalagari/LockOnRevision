import { Loader2, MessageSquare, Send, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../context/AuthContext.jsx";
import { EmptyState } from "./EmptyState.jsx";
import { MessageContent } from "./MessageContent.jsx";
import { getAiContext } from "../services/aiContextService.js";
import { apiFetch } from "../utils/apiFetch.js";
import i18n from "../i18n/index.js";

const MESSAGES_KEY = "lockon-ai-messages";

function loadMessages() {
  try {
    const raw = localStorage.getItem(MESSAGES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveMessages(messages) {
  try {
    localStorage.setItem(MESSAGES_KEY, JSON.stringify(messages.slice(-50)));
  } catch { /* noop */ }
}

export function AiSidebar() {
  const { t } = useTranslation();
  const { user, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState(loadMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [context, setContext] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const scrollRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    let active = true;
    apiFetch("/api/ai-status", { method: "GET" })
      .then((res) => (res.ok ? res.json() : null))
      .then((status) => {
        if (active) setAiStatus(status);
      })
      .catch(() => {
        if (active) setAiStatus(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (open) {
      // Small delay to ensure the element is visible and focusable
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    async function loadContext() {
      if (user) {
        try {
          const ctx = await getAiContext(user.uid, profile);
          setContext(ctx);
        } catch {
          setContext(null);
        }
      }
    }
    loadContext();
  }, [user, profile]);

  // Persist messages to localStorage
  const setMessagesAndPersist = useCallback((updater) => {
    setMessages((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      saveMessages(next);
      return next;
    });
  }, []);

  // Cleanup abort controller on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading, open]);

  const abortRef = useRef(null);

  async function handleSubmit(event) {
    event.preventDefault();
    if (!input.trim() || loading) return;

    // Cancel any previous in-flight request
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const abortController = new AbortController();
    abortRef.current = abortController;

    const userMessage = { role: "user", content: input.trim(), _id: `msg-${Date.now()}` };
    const nextMessages = [...messages, userMessage];
    setMessagesAndPersist(nextMessages);
    setInput("");
    setError("");
    setLoading(true);

    try {
      const response = await apiFetch('/api/ai-tutor-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({ 
          messages: nextMessages,
          context: context,
          preferredLanguage: i18n.language
        }),
      });

      if (!response.ok) {
        let errorDetail = '';
        try {
          const errData = await response.json();
          errorDetail = errData.error || '';
        } catch {}
        throw new Error(`API request failed: ${response.status}${errorDetail ? ` - ${errorDetail}` : ''}`);
      }

      const data = await response.json();
      const reply = data.reply || data.error || t("ai_sidebar.fallback_reply");
      setMessagesAndPersist([...nextMessages, { role: "assistant", content: reply }]);
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("AI Assistant Error:", err);
      const raw = err.message || "";
      const userMessage = raw.includes("503") || raw.includes("gemini_not_configured")
        ? raw.replace("API request failed: 503 - ", "")
        : raw.includes("401") || raw.includes("Authentication failed")
          ? "The AI assistant is running in local demo mode. Please try again in a moment."
          : raw.includes("500")
            ? t("ai_sidebar.error_500")
            : raw || t("ai_sidebar.error_unexpected");
      setError(userMessage);
      setMessagesAndPersist([
        ...nextMessages,
        { role: "assistant", content: userMessage },
      ]);
    } finally {
      setLoading(false);
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    }
  }

  return (
    <>
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen(true)}
      className={`fixed bottom-6 right-6 z-30 grid h-14 w-14 place-items-center rounded-full bg-gradient-to-br from-secondary to-primary text-white shadow-xl transition-all duration-300 hover:scale-110 hover:shadow-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
        open ? "pointer-events-none scale-0 opacity-0" : "scale-100 opacity-100"
      }`}
      aria-label={t("ai.open")}
    >
      <Sparkles size={22} />
    </button>


       <aside
          className={`fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl transition-transform duration-300 ease-in-out ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
          inert={!open ? "" : undefined}
          aria-hidden={!open}
          style={{ visibility: open ? 'visible' : 'hidden' }}
       >
        <div className="flex items-center justify-between border-b border-border px-4 py-4">
           <div className="flex items-center gap-2">
             <MessageSquare className="text-primary" size={18} />
             <div>
               <p className="text-sm font-black text-text-primary">{t("ai.title")}</p>
                <p className="text-xs text-text-secondary">{t("ai.subtitle")}</p>
                {aiStatus ? (
                  aiStatus.configured ? (
                    <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-black text-status-success">
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-status-success" />
                      {t("ai.connected_gemini", { model: aiStatus.model })}
                    </p>
                  ) : (
                    <p className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-black text-warning">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
                      {t("ai.not_connected_gemini", { apiKey: "GEMINI_API_KEY" })}
                    </p>
                  )
                ) : null}
             </div>
           </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-xl border border-border bg-surface p-2 text-text-secondary transition-colors hover:bg-primary hover:text-white"
              aria-label={t("common.close")}
            >
              <X size={18} />
            </button>

         </div>

         <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-background p-4">
           {messages.length ? (
             <div className="grid gap-3">
               {messages.map((message, index) => (
                 <div
                   key={message._id || `${message.role}-${index}`}
                   className={`max-w-[90%] rounded-2xl px-4 py-2 text-sm leading-relaxed transition-all ${
                      message.role === "user"
                        ? "ml-auto bg-secondary text-white shadow-sm"
                        : "border border-border bg-surface text-text-primary shadow-sm"

                   }`}
                 >
                    <MessageContent content={message.content} />
                 </div>
               ))}
               {loading ? (
                 <div className="inline-flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-2 text-sm text-text-secondary">
                   <Loader2 size={16} className="animate-spin text-primary" />
                   {t("common.loading")}
                 </div>
               ) : null}
             </div>
           ) : (
             <EmptyState
                title={t("ai.empty_title")}
                copy={t("ai.empty_desc")}
             />
           )}
         </div>

         {error ? <p className="border-t border-status-error/20 bg-status-error/10 px-4 py-2 text-xs font-bold text-status-error">{error}</p> : null}

         <form onSubmit={handleSubmit} className="border-t border-border p-4 bg-surface">
           <div className="flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={t("ai.placeholder")}
                className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none focus:border-primary transition-all"
                disabled={loading}
              />

              <button
                type="submit"
                disabled={loading || !input.trim()}
                className="rounded-xl bg-primary px-3 py-2 text-white transition-all hover:bg-primary-active disabled:bg-background disabled:text-text-muted"
                aria-label={t("ai.send")}
              >
                <Send size={18} />
              </button>

           </div>
         </form>
      </aside>
    </>
  );
}
