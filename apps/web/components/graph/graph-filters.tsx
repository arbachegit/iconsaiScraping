'use client';

import { useState, useCallback } from 'react';
import { Filter, RotateCcw } from 'lucide-react';
import type { GraphFilters, EntityType, RelationshipType } from './types';
import { ENTITY_TYPES, RELATIONSHIP_TYPES } from './types';
import { ENTITY_COLORS, EDGE_STYLES } from './styles';

interface GraphFiltersProps {
  filters: GraphFilters;
  onApply: (filters: GraphFilters) => void;
}

const ENTITY_LABELS: Record<EntityType, string> = {
  empresa: 'Empresas',
  pessoa: 'Pessoas',
  politico: 'Politicos',
  mandato: 'Mandatos',
  emenda: 'Emendas',
  noticia: 'Noticias',
};

const RELATIONSHIP_LABELS: Record<RelationshipType, string> = {
  societaria: 'Societaria',
  fundador: 'Fundador',
  diretor: 'Diretor',
  fornecedor: 'Fornecedor',
  empregado: 'Empregado',
  emenda_beneficiario: 'Beneficiario',
  mencionado_em: 'Mencionado',
  noticia_menciona: 'Noticia menciona',
};

export function GraphFiltersPanel({ filters, onApply }: GraphFiltersProps) {
  const [localFilters, setLocalFilters] = useState<GraphFilters>(filters);
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleEntityType = useCallback((type: EntityType) => {
    setLocalFilters((prev) => {
      const types = prev.entityTypes.includes(type)
        ? prev.entityTypes.filter((t) => t !== type)
        : [...prev.entityTypes, type];
      return { ...prev, entityTypes: types };
    });
  }, []);

  const toggleRelationshipType = useCallback((type: RelationshipType) => {
    setLocalFilters((prev) => {
      const types = prev.relationshipTypes.includes(type)
        ? prev.relationshipTypes.filter((t) => t !== type)
        : [...prev.relationshipTypes, type];
      return { ...prev, relationshipTypes: types };
    });
  }, []);

  const handleStrengthChange = useCallback((value: number) => {
    setLocalFilters((prev) => ({ ...prev, minStrength: value }));
  }, []);

  const handleApply = useCallback(() => {
    onApply(localFilters);
  }, [onApply, localFilters]);

  const handleReset = useCallback(() => {
    const defaultFilters: GraphFilters = {
      entityTypes: [...ENTITY_TYPES],
      relationshipTypes: [...RELATIONSHIP_TYPES],
      minStrength: 0,
    };
    setLocalFilters(defaultFilters);
    onApply(defaultFilters);
  }, [onApply]);

  return (
    <div className="rounded border border-gray-800 bg-gray-900">
      <button
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-gray-300 transition-colors hover:bg-gray-800"
      >
        <span className="flex items-center gap-1.5">
          <Filter size={14} />
          Filters
        </span>
        <span className="text-gray-500">{isExpanded ? '-' : '+'}</span>
      </button>

      {isExpanded && (
        <div className="space-y-4 border-t border-gray-800 px-3 py-3">
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
              Entity Types
            </h4>
            <div className="grid grid-cols-2 gap-1">
              {ENTITY_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={localFilters.entityTypes.includes(type)}
                    onChange={() => toggleEntityType(type)}
                    className="h-3 w-3 rounded border-gray-600 bg-gray-800"
                  />
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: ENTITY_COLORS[type] }}
                  />
                  <span className="text-gray-300">{ENTITY_LABELS[type]}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
              Relationships
            </h4>
            <div className="grid grid-cols-2 gap-1">
              {RELATIONSHIP_TYPES.map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-xs transition-colors hover:bg-gray-800"
                >
                  <input
                    type="checkbox"
                    checked={localFilters.relationshipTypes.includes(type)}
                    onChange={() => toggleRelationshipType(type)}
                    className="h-3 w-3 rounded border-gray-600 bg-gray-800"
                  />
                  <span className="text-gray-300">{RELATIONSHIP_LABELS[type]}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-gray-500">
              Min Strength: {localFilters.minStrength.toFixed(1)}
            </h4>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={localFilters.minStrength}
              onChange={(e) => handleStrengthChange(parseFloat(e.target.value))}
              className="w-full accent-gray-500"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleApply}
              className="flex-1 rounded bg-gray-700 px-3 py-1.5 text-xs text-gray-200 transition-colors hover:bg-gray-600"
            >
              Apply
            </button>
            <button
              onClick={handleReset}
              className="flex items-center gap-1 rounded bg-gray-800 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:bg-gray-700"
            >
              <RotateCcw size={12} />
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
