import { dia, layout, shapes, util } from 'jointjs';
import * as dagre from 'dagre';
import * as graphlib from 'graphlib';
import { StrictMap } from '../../util/strictMap';
import { ObjectDiagram } from '../../object-diagram/model/objectDiagram';
import { Field } from '../../object-diagram/model/field';
import { Reference } from '../../object-diagram/model/reference';
import { DebuggerPanel, registerDebuggerPanelFactory } from './debuggerPanel';
import { DebuggerPanelMessageService } from './debuggerPanelMessageService';
import { JointJsRenderingAreaData } from './joint-js/model/jointJsRenderingAreaData';
import { JointJsRenderingAreaOptions } from './joint-js/model/jointJsRenderingAreaOptions';
import {
  FieldToBeAdded,
  FieldToBeRemoved,
  FieldToBeUpdated,
  JointJsRenderingAreaUpdateData,
  ReferenceToBeAdded,
  ReferenceToBeRemoved,
  ReferenceToBeUpdated,
  StructureToBeAdded,
  StructureToBeRemoved,
  StructureToBeUpdated,
} from './joint-js/model/jointJsRenderingAreaUpdateData';
import { JointJsPanelViewColors } from './joint-js/model/jointJsPanelViewColors';
import { JointJsColors } from './joint-js/model/jointJsColors';
import { ReferenceShape } from './joint-js/shapes/referenceShape';
import { StructureShape } from './joint-js/shapes/structureShape';

export class JointJsDebuggerPanel extends DebuggerPanel<
  JointJsRenderingAreaData,
  JointJsRenderingAreaOptions,
  JointJsRenderingAreaUpdateData
> {
  private _graph?: dia.Graph;
  private _paper?: dia.Paper;
  private panelViewColors?: JointJsPanelViewColors;
  private structureShapesById = new StrictMap<string, StructureShape>();
  private referenceShapesById = new StrictMap<string, ReferenceShape>();

  constructor(window: Window, document: Document, messageService: DebuggerPanelMessageService) {
    super(window, document, messageService);
  }

  //  Event processing :: Message -> Rendering area

  protected initializeRenderingArea(
    renderingArea: HTMLDivElement,
    { objectDiagram }: JointJsRenderingAreaData,
    { panelViewColors }: JointJsRenderingAreaOptions
  ): void {
    renderingArea.innerHTML = '';
    const graph = new dia.Graph({}, JointJsDebuggerPanel.createGraphOptions());
    this._graph = graph;
    this._paper = new dia.Paper(JointJsDebuggerPanel.createPaperOptions(graph, renderingArea));
    this.window.addEventListener(
      'resize',
      util.debounce((): void => this.fitPaperToContent())
    );
    this.panelViewColors = panelViewColors;
    this.initializeFromObjectDiagram(objectDiagram);
  }

  protected updateRenderingArea(data: JointJsRenderingAreaUpdateData): void {
    this.initializeFromObjectDiagram({
      structures: data.structuresToBeRestored,
      fields: data.fieldsToBeRestored,
      references: data.referencesToBeRestored,
    });
    this.runWithFrozenPaper(() => {
      this.removeReferences(data.referencesToBeRemoved);
      this.removeFields(data.fieldsToBeRemoved);
      this.removeStructures(data.structuresToBeRemoved);
      this.resetColorsOfStructureShapes();
      this.resetColorsOfReferenceShapes();
      this.updateStructures(data.structuresToBeUpdated);
      this.updateFields(data.fieldsToBeUpdated);
      //  We have to add the new structures first
      //  this.updateReferences(data.referencesToBeUpdated);
      const { panelViewColors } = this;
      const changedVariableColor = panelViewColors?.changedVariableColor;
      this.addStructures(data.structuresToBeAdded, panelViewColors?.changedNodeColor, changedVariableColor);
      this.addFields(data.fieldsToBeAdded, changedVariableColor);
      this.addReferences(data.referencesToBeAdded, changedVariableColor);
      //  We had to add the new structures first
      // this.removeReferences(data.referencesToBeRemoved);
      this.updateReferences(data.referencesToBeUpdated);
      this.optimizeGeometry();
    });
  }

  protected exportImage(renderingArea: HTMLDivElement): void {
    const svgSvgElement = renderingArea.querySelector('svg');
    if (!svgSvgElement) {
      throw new Error('SVG element not found');
    }
    const { document } = this;
    const svgSvgElementDeepClone = svgSvgElement.cloneNode(true) as SVGSVGElement;
    Array.from(document.styleSheets)
      .reverse()
      .forEach((styleSheet) => {
        const styleElement = document.createElement('style');
        styleElement.textContent = Array.from(styleSheet.cssRules)
          .map(({ cssText }) => cssText)
          .join('');
        svgSvgElementDeepClone.prepend(styleElement);
      });
    this.downloadFile(
      'export.svg',
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svgSvgElementDeepClone))}`
    );
  }

  //  Initialization :: UI :: Graph & paper

  private static createGraphOptions(): dia.Graph.Options {
    return {
      ...this.createGraphAndPaperOptions(),
    };
  }

  private static createPaperOptions(graph: dia.Graph, renderingArea: HTMLDivElement): dia.Paper.Options {
    return {
      ...this.createGraphAndPaperOptions(),
      model: graph,
      el: renderingArea,
      gridSize: 1,
    };
  }

  private static createGraphAndPaperOptions(): dia.Graph.Options & dia.Paper.Options {
    return {
      cellNamespace: shapes,
    };
  }

  //  Initialization

  private initializeFromObjectDiagram(diagram: ObjectDiagram): void {
    this.runWithFrozenPaper(() => {
      const { panelViewColors } = this;
      this.graph.clear();
      this.deleteAllShapes();
      const defaultVariableColor = panelViewColors?.defaultVariableColor;
      this.addStructures(diagram.structures, panelViewColors?.defaultNodeColor, defaultVariableColor);
      this.addFields(diagram.fields, defaultVariableColor);
      this.addReferences(diagram.references, defaultVariableColor);
      this.optimizeGeometry();
    });
  }

  private deleteAllShapes(): void {
    this.structureShapesById.clear();
    this.referenceShapesById.clear();
  }

  //  Geometry

  private optimizeGeometry(): void {
    this.optimizeStructureShapeSizes();
    this.setStructureShapeEgressPortYs();
    this.layoutGraph();
    this.fitPaperToContent();
  }

  //  Geometry :: Shaping

  private optimizeStructureShapeSizes(): void {
    const { document } = this;
    for (const structureShape of this.structureShapesById.values()) {
      structureShape.optimizeSize(document);
    }
  }

  private setStructureShapeEgressPortYs(): void {
    for (const structureShape of this.structureShapesById.values()) {
      structureShape.setEgressPortYs();
    }
  }

  //  Geometry :: Graph layout

  private layoutGraph(): void {
    layout.DirectedGraph.layout(
      this.graph.getSubgraph(Array.from(this.structureShapesById.values())),
      JointJsDebuggerPanel.createDirectedGraphLayoutOptions()
    );
  }

  private static createDirectedGraphLayoutOptions(): layout.DirectedGraph.LayoutOptions {
    return {
      dagre,
      graphlib,
      align: 'UL',
      rankDir: 'TB',
      ranker: 'network-simplex',
      nodeSep: 50,
      edgeSep: 50,
      rankSep: 50,
      resizeClusters: true,
      setVertices: false,
      setLabels: false,
    };
  }

  //  Geometry :: Fitting & scaling

  private fitPaperToContent(): void {
    this.paper.fitToContent(JointJsDebuggerPanel.createPaperFitToContentOptions());
  }

  private scaleContentToFit(): void {
    this.paper.scaleContentToFit(JointJsDebuggerPanel.createPaperScaleContentOptions());
  }

  private static createPaperFitToContentOptions(): dia.Paper.FitToContentOptions {
    return {
      ...JointJsDebuggerPanel.createPaperFitAndScaleOptions(),
      allowNewOrigin: 'any',
    };
  }

  private static createPaperScaleContentOptions(): dia.Paper.ScaleContentOptions {
    return {
      ...this.createPaperFitAndScaleOptions(),
    };
  }

  private static createPaperFitAndScaleOptions(): dia.Paper.FitToContentOptions & dia.Paper.ScaleContentOptions {
    return {
      padding: Math.max(this.toolBarHeight, this.statusBarHeight) + 10,
      useModelGeometry: true,
    };
  }

  private static readonly toolBarHeight = 40;

  private static readonly statusBarHeight = 40;

  //  Operations :: Structures

  private addStructures(
    structures: StructureToBeAdded[],
    nodeColors: JointJsColors | undefined,
    variableColors: JointJsColors | undefined
  ): void {
    structures.forEach((structure) => this.addStructure(structure, nodeColors, variableColors));
  }

  private updateStructures(structures: StructureToBeUpdated[]): void {
    structures.forEach((structure) => this.updateStructure(structure));
  }

  private removeStructures(structures: StructureToBeRemoved[]): void {
    structures.forEach((structure) => this.removeStructure(structure));
  }

  private resetColorsOfStructureShapes(): void {
    for (const structureShape of this.structureShapesById.values()) {
      this.resetColorsOfStructureShape(structureShape);
    }
  }

  //  Operations :: Fields

  private addFields(fields: FieldToBeAdded[], colors: JointJsColors | undefined): void {
    fields.forEach((field) => this.addField(field, colors));
  }

  private updateFields(fields: FieldToBeUpdated[]): void {
    fields.forEach((field) => this.updateField(field));
  }

  private removeFields(fields: FieldToBeRemoved[]): void {
    fields.forEach((field) => this.removeField(field));
  }

  //  Operations :: References

  private addReferences(references: ReferenceToBeAdded[], colors: JointJsColors | undefined): void {
    references.forEach((reference) => this.addReference(reference, colors));
  }

  private updateReferences(references: ReferenceToBeUpdated[]): void {
    references.forEach((reference) => this.updateReference(reference));
  }

  private removeReferences(references: ReferenceToBeRemoved[]): void {
    references.forEach((reference) => this.removeReference(reference));
  }

  private resetColorsOfReferenceShapes(): void {
    for (const referenceShape of this.referenceShapesById.values()) {
      this.resetColorsOfReferenceShape(referenceShape);
    }
  }

  //  Operations :: Structures

  private addStructure(
    structure: StructureToBeAdded,
    nodeColors: JointJsColors | undefined,
    variableColors: JointJsColors | undefined
  ): void {
    const structureShape = StructureShape.create(structure, nodeColors, variableColors);
    this.structureShapesById.set(structure.id, structureShape);
    structureShape.addTo(this.graph);
  }

  private updateStructure(structure: StructureToBeUpdated): void {
    this.structureShapesById.get(structure.id).updateStructure(structure, this.panelViewColors?.changedNodeColor);
  }

  private removeStructure({ id }: StructureToBeRemoved): void {
    this.structureShapesById.get(id).remove();
    this.structureShapesById.delete(id);
  }

  private resetColorsOfStructureShape(structureShape: StructureShape): void {
    structureShape.setColors(this.panelViewColors?.defaultNodeColor, this.panelViewColors?.defaultVariableColor);
  }

  //  Operations :: Fields

  private addField(field: FieldToBeAdded, colors: JointJsColors | undefined): void {
    this.getStructureShapeForField(field).addField(field, colors);
  }

  private updateField(field: FieldToBeUpdated): void {
    this.getStructureShapeForField(field).updateField(field, this.panelViewColors?.changedVariableColor);
  }

  private removeField(field: FieldToBeRemoved): void {
    this.getStructureShapeForField(field).removeField(field);
  }

  private getStructureShapeForField({ parentId }: Pick<Field, 'parentId'>): StructureShape {
    return this.structureShapesById.get(parentId);
  }

  //  Operations :: References

  private addReference(reference: ReferenceToBeAdded, colors: JointJsColors | undefined): void {
    const { structureShapesById } = this;
    const { startId, endId, name } = reference;
    const source = structureShapesById.get(startId);
    source.addEgressReference(reference, colors);
    const sourcePort = source.egressPorts.find(({ id }) => id === name);
    if (!sourcePort) {
      throw new Error('Cannot add reference: Source port not found');
    }
    const target = structureShapesById.get(endId);
    const targetPort = target.ingressPort;
    const referenceShape = ReferenceShape.create(
      {
        id: source.id,
        port: sourcePort.id,
      },
      {
        id: target.id,
        port: targetPort.id,
      },
      colors
    );
    this.referenceShapesById.set(JointJsDebuggerPanel.getReferenceShapeId(reference), referenceShape);
    referenceShape.addTo(this.graph);
  }

  private updateReference(reference: ReferenceToBeUpdated): void {
    const target = this.structureShapesById.get(reference.endId);
    this.getShapeForReference(reference).updateReference(
      {
        id: target.id,
        port: target.ingressPort.id,
      },
      this.panelViewColors?.changedVariableColor
    );
    this.structureShapesById.get(reference.startId).updateEgressReference(reference, this.panelViewColors?.changedVariableColor);
  }

  private removeReference(reference: ReferenceToBeRemoved): void {
    const id = JointJsDebuggerPanel.getReferenceShapeId(reference);
    this.referenceShapesById.get(id).remove();
    this.referenceShapesById.delete(id);
    this.structureShapesById.get(reference.startId).removeEgressReference(reference);
  }

  private resetColorsOfReferenceShape(referenceShape: ReferenceShape): void {
    referenceShape.colors = this.panelViewColors?.defaultVariableColor;
  }

  private getShapeForReference(reference: Reference): ReferenceShape {
    return this.referenceShapesById.get(JointJsDebuggerPanel.getReferenceShapeId(reference));
  }

  private static getReferenceShapeId({ startId, name }: Reference): string {
    return `${startId}${this.structureIdAndFieldNameSeparator}${name}`;
  }

  private static readonly structureIdAndFieldNameSeparator = '.';

  //  Utilities :: Safe access

  private get graph(): dia.Graph {
    const graph = this._graph;
    if (!graph) {
      throw new Error('Graph not set');
    }
    return graph;
  }

  private get paper(): dia.Paper {
    const paper = this._paper;
    if (!paper) {
      throw new Error('Paper not set');
    }
    return paper;
  }

  private runWithFrozenPaper(callback: (paper: dia.Paper) => void): void {
    const { paper } = this;
    paper.freeze();
    callback(paper);
    paper.unfreeze();
  }
}

registerDebuggerPanelFactory((window, document, messageService) => new JointJsDebuggerPanel(window, document, messageService));
