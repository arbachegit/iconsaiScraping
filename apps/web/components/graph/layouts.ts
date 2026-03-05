import type { LayoutOptions } from 'cytoscape';
import type { LayoutType } from './types';

type FcoseLayoutOptions = LayoutOptions & {
  name: 'fcose';
  quality: string;
  randomize: boolean;
  animate: boolean;
  animationDuration: number;
  nodeSeparation: number;
  idealEdgeLength: number;
  nodeRepulsion: () => number;
  edgeElasticity: () => number;
  gravity: number;
  gravityRange: number;
};

type DagreLayoutOptions = LayoutOptions & {
  name: 'dagre';
  rankDir: string;
  nodeSep: number;
  rankSep: number;
  animate: boolean;
  animationDuration: number;
};

type ConcentricLayoutOptions = LayoutOptions & {
  name: 'concentric';
  concentric: (node: { degree: () => number }) => number;
  levelWidth: (nodes: { maxDegree: () => number }) => number;
  minNodeSpacing: number;
  animate: boolean;
  animationDuration: number;
};

type LayoutConfig = FcoseLayoutOptions | DagreLayoutOptions | ConcentricLayoutOptions;

const fcoseLayout = (nodeCount: number): FcoseLayoutOptions => ({
  name: 'fcose',
  quality: 'default',
  randomize: true,
  animate: true,
  animationDuration: 500,
  nodeSeparation: Math.max(75, 200 - nodeCount),
  idealEdgeLength: Math.max(50, 150 - nodeCount * 0.5),
  nodeRepulsion: () => Math.max(4500, 8000 - nodeCount * 10),
  edgeElasticity: () => 0.45,
  gravity: 0.25,
  gravityRange: 3.8,
});

const dagreLayout = (_nodeCount: number): DagreLayoutOptions => ({
  name: 'dagre',
  rankDir: 'TB',
  nodeSep: 60,
  rankSep: 80,
  animate: true,
  animationDuration: 500,
});

const concentricLayout = (_nodeCount: number): ConcentricLayoutOptions => ({
  name: 'concentric',
  concentric: (node: { degree: () => number }) => node.degree(),
  levelWidth: (nodes: { maxDegree: () => number }) => Math.max(1, Math.floor(nodes.maxDegree() / 4)),
  minNodeSpacing: 50,
  animate: true,
  animationDuration: 500,
});

export function getLayoutOptions(type: LayoutType, nodeCount: number): LayoutConfig {
  switch (type) {
    case 'fcose':
      return fcoseLayout(nodeCount);
    case 'dagre':
      return dagreLayout(nodeCount);
    case 'concentric':
      return concentricLayout(nodeCount);
    default:
      return fcoseLayout(nodeCount);
  }
}
