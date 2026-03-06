'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import type { Core } from 'cytoscape';
import type { GraphNode } from './types';
import { ENTITY_COLORS } from './styles';

interface GraphSearchProps {
  cy: Core | null;
  onSelectResult?: (node: GraphNode) => void;
}

interface SearchResult {
  id: string;
  type: string;
  label: string;
}

export function GraphSearch({ cy, onSelectResult }: GraphSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const searchGraph = useCallback(
    async (term: string) => {
      if (term.length < 2) {
        setResults([]);
        return;
      }

      setIsLoading(true);

      try {
        const res = await fetch(`/api/graph/search?q=${encodeURIComponent(term)}`);
        if (res.ok) {
          const data: SearchResult[] = await res.json();
          setResults(data);
          setIsOpen(true);
        }
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setQuery(value);

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => searchGraph(value), 300);
    },
    [searchGraph]
  );

  const handleSelectResult = useCallback(
    (result: SearchResult) => {
      setIsOpen(false);
      setQuery(result.label);

      if (cy) {
        const node = cy.getElementById(result.id);
        if (node && !node.empty()) {
          cy.animate({
            center: { eles: node },
            zoom: 2,
          });
          node.select();
        }
      }

      onSelectResult?.({
        id: result.id,
        type: result.type as GraphNode['type'],
        label: result.label,
      });
    },
    [cy, onSelectResult]
  );

  const handleClear = useCallback(() => {
    setQuery('');
    setResults([]);
    setIsOpen(false);
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div className="relative w-64">
      <div className="flex items-center rounded border border-cyan-500/20 bg-[#1a2332] px-2">
        <Search size={14} className="flex-shrink-0 text-slate-500" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleInputChange}
          onFocus={() => results.length > 0 && setIsOpen(true)}
          placeholder="Search nodes..."
          className="w-full bg-transparent px-2 py-1.5 text-xs text-slate-200 placeholder-slate-500 outline-none"
        />
        {query && (
          <button onClick={handleClear} className="flex-shrink-0 text-slate-500 hover:text-slate-300">
            <X size={14} />
          </button>
        )}
      </div>

      {isOpen && results.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded border border-cyan-500/20 bg-[#0f1629] shadow-xl">
          {results.map((result) => (
            <li key={result.id}>
              <button
                onClick={() => handleSelectResult(result)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-cyan-500/5"
              >
                <div
                  className="h-2 w-2 flex-shrink-0 rounded-full"
                  style={{ backgroundColor: ENTITY_COLORS[result.type] || '#6b7280' }}
                />
                <span className="min-w-0 flex-1 truncate text-slate-200">{result.label}</span>
                <span className="flex-shrink-0 text-slate-500">{result.type}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {isOpen && isLoading && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded border border-cyan-500/20 bg-[#0f1629] px-3 py-2 text-xs text-slate-500">
          Searching...
        </div>
      )}
    </div>
  );
}
