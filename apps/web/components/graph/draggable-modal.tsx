'use client';

import { useRef, useState, useCallback, useEffect } from 'react';

interface DraggableModalProps {
  children: React.ReactNode;
  zIndex?: number;
  onClose: () => void;
  className?: string;
}

export function DraggableModal({ children, zIndex = 100, onClose, className = '' }: DraggableModalProps) {
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const modalRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only drag from the header area (first child or element with data-drag-handle)
    const target = e.target as HTMLElement;
    if (!target.closest('[data-drag-handle]')) return;

    dragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    e.preventDefault();
  }, [pos]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setPos({
        x: e.clientX - dragStart.current.x,
        y: e.clientY - dragStart.current.y,
      });
    };
    const handleMouseUp = () => {
      dragging.current = false;
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  return (
    <div
      className="fixed inset-0"
      style={{ zIndex }}
      onClick={onClose}
    >
      <div
        ref={modalRef}
        className={`absolute left-1/2 top-1/2 ${className}`}
        style={{
          transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))`,
        }}
        onClick={e => e.stopPropagation()}
        onMouseDown={handleMouseDown}
      >
        {children}
      </div>
    </div>
  );
}
