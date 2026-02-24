'use client';

import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  MessageCircle,
  X,
  Send,
  Loader2,
  Users,
  Building2,
  MapPin,
  BarChart3,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { atlasChat, type AtlasChatResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  data?: unknown[];
  suggestions?: string[];
}

const MODULES = [
  {
    id: 'politicians',
    label: 'Politicos',
    icon: Users,
    description: 'Buscar politicos por nome, partido ou municipio',
    variant: 'default' as const,
  },
  {
    id: 'parties',
    label: 'Partidos',
    icon: Building2,
    description: 'Lista de partidos e estatisticas',
    variant: 'secondary' as const,
  },
  {
    id: 'municipalities',
    label: 'Municipios',
    icon: MapPin,
    description: 'Politicos por cidade ou regiao',
    variant: 'success' as const,
  },
  {
    id: 'statistics',
    label: 'Estatisticas',
    icon: BarChart3,
    description: 'Numeros e analises eleitorais',
    variant: 'warning' as const,
  },
];

export function AtlasChat() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chatMutation = useMutation({
    mutationFn: atlasChat,
    onSuccess: (data: AtlasChatResponse) => {
      setSessionId(data.sessionId);
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          role: 'assistant',
          content: data.text,
          data: data.data,
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
    chatMutation.mutate({ message: input, sessionId });
    setInput('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleModuleClick(moduleId: string) {
    const prompts: Record<string, string> = {
      politicians: 'Quem sao os politicos mais conhecidos?',
      parties: 'Quais sao os partidos politicos?',
      municipalities: 'Quais municipios tem mais politicos eleitos?',
      statistics: 'Me mostre estatisticas eleitorais',
    };

    setInput(prompts[moduleId] || '');
    inputRef.current?.focus();
  }

  function handleSuggestionClick(suggestion: string) {
    setInput(suggestion);
    inputRef.current?.focus();
  }

  return (
    <>
      {/* FAB Button with Radar + Beacon */}
      <div className="fixed bottom-6 right-6 z-50">
        {/* Radar pulse rings (only when closed) */}
        {!isOpen && (
          <>
            <span
              className="absolute inset-0 rounded-full bg-cyan-500/20"
              style={{
                animation: 'atlas-radar 3s ease-out infinite',
              }}
            />
            <span
              className="absolute inset-0 rounded-full bg-cyan-500/15"
              style={{
                animation: 'atlas-radar 3s ease-out 1s infinite',
              }}
            />
          </>
        )}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'relative flex h-14 w-14 items-center justify-center rounded-full shadow-lg transition-all duration-300',
            'bg-gradient-to-br from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500',
            'hover:scale-110 hover:shadow-cyan-500/30 hover:shadow-xl',
            isOpen && 'rotate-90'
          )}
        >
          {isOpen ? (
            <X className="h-6 w-6 text-white" />
          ) : (
            <Sparkles className="h-6 w-6 text-white" />
          )}
        </button>
        {/* Red beacon dot - tangent to top-right of button */}
        {!isOpen && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 w-3.5">
            <span className="absolute inset-0 rounded-full bg-red-500 animate-ping opacity-75" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-red-500 border-2 border-[#0a0e1a]" />
          </span>
        )}
      </div>

      {/* Chat Window */}
      <div
        className={cn(
          'fixed bottom-24 right-6 z-50 w-96 transition-all duration-300',
          'rounded-2xl border border-cyan-500/20 bg-[#0f1629]/95 backdrop-blur-xl shadow-2xl shadow-cyan-500/10',
          isOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-cyan-500/20 bg-gradient-to-r from-cyan-500/10 to-blue-500/10 rounded-t-2xl">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500 to-blue-600">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Atlas</h3>
              <p className="text-xs text-muted-foreground">Assistente de Dados Politicos</p>
            </div>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="rounded-lg p-2 hover:bg-white/5 transition-colors"
          >
            <X className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {/* Messages */}
        <ScrollArea className="h-80 p-4">
          {messages.length === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Ola! Sou o Atlas, seu assistente para dados politicos brasileiros. Como posso
                ajudar?
              </p>
              <div className="grid grid-cols-2 gap-2">
                {MODULES.map((module) => (
                  <Badge
                    key={module.id}
                    variant={module.variant}
                    onClick={() => handleModuleClick(module.id)}
                    className="flex-col items-start h-auto py-2 px-3"
                  >
                    <div className="flex items-center gap-1.5">
                      <module.icon className="h-3.5 w-3.5" />
                      <span>{module.label}</span>
                    </div>
                  </Badge>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn(
                    'animate-fade-in',
                    message.role === 'user' ? 'flex justify-end' : ''
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-xl px-4 py-2.5 text-sm',
                      message.role === 'user'
                        ? 'bg-cyan-500/20 text-foreground ml-auto'
                        : 'bg-white/5 text-foreground'
                    )}
                  >
                    <p className="whitespace-pre-wrap">{message.content}</p>

                    {message.suggestions && message.suggestions.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {message.suggestions.map((suggestion, i) => (
                          <Badge
                            key={i}
                            variant="outline"
                            onClick={() => handleSuggestionClick(suggestion)}
                            className="text-xs"
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
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-sm">Processando...</span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </ScrollArea>

        {/* Input */}
        <div className="p-4 border-t border-cyan-500/20">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Digite sua pergunta..."
              className="flex-1 h-10"
              disabled={chatMutation.isPending}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || chatMutation.isPending}
              className="h-10 w-10"
            >
              {chatMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
