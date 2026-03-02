'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  X,
  Send,
  Loader2,
  UserSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  peopleAgentChat,
  type PeopleAgentChatResponse,
  type PeopleAgentSearchContext,
} from '@/lib/api';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  suggestions?: string[];
}

interface PeopleAgentInlineChatProps {
  searchContext?: PeopleAgentSearchContext;
  onClose: () => void;
  isOpen: boolean;
}

const QUICK_PROMPTS = [
  'Resuma os resultados',
  'Quem tem melhor perfil?',
  'Me conte sobre o primeiro',
  'Compare os resultados',
];

export function PeopleAgentInlineChat({ searchContext, onClose, isOpen }: PeopleAgentInlineChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chatMutation = useMutation({
    mutationFn: (message: string) =>
      peopleAgentChat({
        message,
        sessionId,
        searchContext: searchContext || undefined,
      }),
    onSuccess: (data: PeopleAgentChatResponse) => {
      setSessionId(data.sessionId);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: data.text,
          suggestions: data.suggestions,
        },
      ]);
    },
    onError: (error: Error) => {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: `Erro: ${error.message}`,
        },
      ]);
    },
  });

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  function handleSend() {
    if (!input.trim() || chatMutation.isPending) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    chatMutation.mutate(input);
    setInput('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSuggestionClick(suggestion: string) {
    if (chatMutation.isPending) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: suggestion,
    };

    setMessages((prev) => [...prev, userMessage]);
    chatMutation.mutate(suggestion);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-violet-500/20 bg-gradient-to-r from-violet-500/5 to-purple-500/5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-purple-600">
            <UserSearch className="h-3.5 w-3.5 text-white" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">People Agent</h3>
            <p className="text-[10px] text-muted-foreground">
              {searchContext?.results?.length
                ? `${searchContext.results.length} resultados no contexto`
                : 'Assistente de busca'}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="rounded-lg p-1.5 hover:bg-white/5 transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-3">
          {messages.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pergunte sobre os resultados da busca. Posso analisar, comparar e detalhar as pessoas encontradas.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {QUICK_PROMPTS.map((prompt) => (
                  <Badge
                    key={prompt}
                    variant="outline"
                    onClick={() => handleSuggestionClick(prompt)}
                    className={cn(
                      'text-xs cursor-pointer transition-colors',
                      'hover:bg-violet-500/10 hover:border-violet-500/30 hover:text-violet-400'
                    )}
                  >
                    {prompt}
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    message.role === 'user' ? 'flex justify-end' : ''
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[90%] rounded-xl px-3 py-2 text-sm',
                      message.role === 'user'
                        ? 'bg-violet-500/20 text-foreground ml-auto'
                        : 'bg-white/5 text-foreground'
                    )}
                  >
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>

                    {message.suggestions && message.suggestions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {message.suggestions.map((suggestion, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            onClick={() => handleSuggestionClick(suggestion)}
                            className="text-[10px] cursor-pointer hover:bg-violet-500/10 hover:border-violet-500/30"
                          >
                            {suggestion}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatMutation.isPending && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="text-xs">Analisando...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="flex-shrink-0 p-3 border-t border-violet-500/20">
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Pergunte sobre os resultados..."
            className="flex-1 h-9 text-sm"
            disabled={chatMutation.isPending}
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!input.trim() || chatMutation.isPending}
            className="h-9 w-9"
          >
            {chatMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
