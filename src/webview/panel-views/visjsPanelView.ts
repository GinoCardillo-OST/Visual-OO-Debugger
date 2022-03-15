import { readFileSync } from 'fs';
import { isEqual, some } from 'lodash';
import { Color, Data, Edge, Node, Options } from 'vis-network';
import { ExtensionContext, Uri, Webview } from 'vscode';
import { PanelViewInputVariableMap, PanelViewVariable, VariableRelation } from '../../model/panelViewInput';
import { ChangeAction, ChangedEdge, ChangedNode, VisjsChangelogEntry } from '../../model/visjsChangelogEntry';
import { VisjsUpdateInput } from '../../model/visjsUpdateInput';
import { NodeModulesAccessor } from '../../node-modules-accessor/nodeModulesAccessor';
import { NodeModulesKeys } from '../../node-modules-accessor/nodeModulesKeys';
import { PanelViewCommand, PanelViewProxy } from './panelViewProxy';

export class VisjsPanelView implements PanelViewProxy {
  private readonly defaultNodeColor: Color = {
    border: '#005cb2',
    background: '#1e88e5',
    highlight: {
      border: '#005cb2',
      background: '#1e88e5',
    },
  };

  private readonly defaultEdgeColor: { color?: string; highlight?: string } = {
    color: '#005cb2',
    highlight: '#005cb2',
  };

  private readonly changedNodeColor: Color = {
    border: '#c6a700',
    background: '#fdd835',
    highlight: {
      border: '#c6a700',
      background: '#fdd835',
    },
  };

  private readonly changedEdgeColor: { color?: string; highlight?: string } = {
    color: '#c6a700',
    highlight: '#c6a700',
  };

  private changelog: VisjsChangelogEntry[] = [];

  private currentPanelViewVariables: PanelViewInputVariableMap | undefined;

  private changelogIndex = -1;

  constructor(private readonly context: ExtensionContext) {}

  getHtml(webview: Webview): string {
    const visNetworkUri = webview.asWebviewUri(
      Uri.joinPath(this.context.extensionUri, ...NodeModulesAccessor.getPathToOutputFile(NodeModulesKeys.visNetworkMinJs))
    );
    const ffmpegUri = webview.asWebviewUri(
      Uri.joinPath(this.context.extensionUri, ...NodeModulesAccessor.getPathToOutputFile(NodeModulesKeys.ffmpegMinJs))
    );
    const ffmpegCoreUri = webview.asWebviewUri(
      Uri.joinPath(this.context.extensionUri, ...NodeModulesAccessor.getPathToOutputFile(NodeModulesKeys.ffmpegCoreJs))
    );
    const codiconsUri = webview.asWebviewUri(
      Uri.joinPath(this.context.extensionUri, ...NodeModulesAccessor.getPathToOutputFile(NodeModulesKeys.codiconCss))
    );
    const webviewUiToolkit = webview.asWebviewUri(
      Uri.joinPath(this.context.extensionUri, ...NodeModulesAccessor.getPathToOutputFile(NodeModulesKeys.webviewUiToolkit))
    );
    const cssUri = webview.asWebviewUri(Uri.joinPath(this.context.extensionUri, 'media', 'css', 'visjsDebuggerPanel.css'));
    const filePath = Uri.joinPath(this.context.extensionUri, 'media', 'html', 'visjsDebuggerPanel.html');
    return readFileSync(filePath.fsPath, 'utf8')
      .replace('{{vis-network.min.js}}', visNetworkUri.toString())
      .replace('{{ffmpeg.min.js}}', ffmpegUri.toString())
      .replace('{{ffmpeg-core.js}}', ffmpegCoreUri.toString())
      .replace('{{visjsDebuggerPanel.css}}', cssUri.toString())
      .replace('{{codicon.css}}', codiconsUri.toString())
      .replace('{{toolkit.min.js}}', webviewUiToolkit.toString());
  }

  teardownPanelView(): void {
    this.changelog = [];
    this.currentPanelViewVariables = undefined;
    this.changelogIndex = -1;
  }

  updatePanel(variables: PanelViewInputVariableMap): PanelViewCommand {
    if (!this.currentPanelViewVariables) {
      this.currentPanelViewVariables = variables;

      const options: Options = {
        nodes: {
          color: this.defaultNodeColor,
          shape: 'box',
        },
        edges: {
          arrows: 'to',
          color: this.defaultEdgeColor,
        },
        physics: {
          solver: 'repulsion',
          repulsion: {
            nodeDistance: 100,
          },
        },
      };

      return { command: 'initializeVisjs', data: this.parseInputToData(variables), options };
    }

    const changelogEntry = this.createChangelogEntry(variables);
    this.currentPanelViewVariables = variables;
    const hasChanges = changelogEntry.edgeChanges?.length > 0 || changelogEntry.nodeChanges?.length > 0;
    if (hasChanges) {
      this.changelog.push(changelogEntry);
    }

    if (!hasChanges || (this.changelogIndex !== -1 && this.changelogIndex < this.changelog.length - 1)) {
      return { command: 'noop' };
    }
    this.changelogIndex = -1;
    return { command: 'updateVisjs', data: this.parseChangelogEntryToUpdateInput(changelogEntry) };
  }

  exportPanel(): PanelViewCommand {
    return { command: 'exportVisjs' };
  }

  startRecordingPanel(): PanelViewCommand {
    return { command: 'startRecordingVisjs' };
  }

  stopRecordingPanel(): PanelViewCommand {
    return { command: 'stopRecordingVisjs' };
  }

  stepForward(): PanelViewCommand {
    if (this.changelogIndex === -1 || this.changelogIndex === this.changelog.length) {
      return { command: 'noop' };
    }
    return { command: 'updateVisjs', data: this.parseChangelogEntryToUpdateInput(this.changelog[this.changelogIndex++]) };
  }

  stepBack(): PanelViewCommand {
    if (this.changelog.length === 0 || this.changelogIndex === 0) {
      return { command: 'noop' };
    }
    if (this.changelogIndex === -1) {
      this.changelogIndex = this.changelog.length - 1;
    } else {
      this.changelogIndex--;
    }
    const invertedChangelogEntry = this.invertChangelogEntry(this.changelog[this.changelogIndex]);
    return { command: 'updateVisjs', data: this.parseChangelogEntryToUpdateInput(invertedChangelogEntry) };
  }

  private invertChangelogEntry(entry: VisjsChangelogEntry): VisjsChangelogEntry {
    return {
      nodeChanges: this.invertNodeChanges(entry.nodeChanges),
      edgeChanges: this.invertEdgeChanges(entry.edgeChanges),
    };
  }

  private invertNodeChanges(nodeChanges: ChangedNode[]): ChangedNode[] {
    const invertedNodeChanges: ChangedNode[] = [];
    for (const nodeChange of nodeChanges) {
      let invertedChange: ChangedNode;
      switch (nodeChange.action) {
        case ChangeAction.create:
          invertedChange = {
            action: ChangeAction.delete,
            node: nodeChange.node,
          };
          break;
        case ChangeAction.delete:
          invertedChange = {
            action: ChangeAction.create,
            node: nodeChange.node,
          };
          break;
        case ChangeAction.update:
          invertedChange = {
            action: ChangeAction.update,
            newNode: nodeChange.oldNode,
            oldNode: nodeChange.newNode,
          };
          break;
      }
      invertedNodeChanges.push(invertedChange);
    }
    return invertedNodeChanges;
  }

  private invertEdgeChanges(edgeChanges: ChangedEdge[]): ChangedEdge[] {
    const invertedEdgeChanges: ChangedEdge[] = [];
    for (const edgeChange of edgeChanges) {
      let invertedChange: ChangedEdge;
      switch (edgeChange.action) {
        case ChangeAction.create:
          invertedChange = {
            action: ChangeAction.delete,
            edge: edgeChange.edge,
          };
          break;
        case ChangeAction.delete:
          invertedChange = {
            action: ChangeAction.create,
            edge: edgeChange.edge,
          };
          break;
      }
      invertedEdgeChanges.push(invertedChange);
    }
    return invertedEdgeChanges;
  }

  private parseChangelogEntryToUpdateInput(changelogEntry: VisjsChangelogEntry): VisjsUpdateInput {
    const addNodes: Node[] = [];
    const updateNodes: Node[] = [];
    const deleteNodeIds: string[] = [];
    const addEdges: Edge[] = [];
    const deleteEdgeIds: string[] = [];

    for (const nodeChange of changelogEntry.nodeChanges) {
      switch (nodeChange.action) {
        case ChangeAction.create:
          addNodes.push({ ...nodeChange.node, color: this.changedNodeColor });
          break;
        case ChangeAction.update:
          updateNodes.push({ ...nodeChange.newNode, color: this.changedNodeColor });
          break;
        case ChangeAction.delete:
          deleteNodeIds.push(nodeChange.node.id as string);
          break;
        default:
      }
    }

    for (const edgeChange of changelogEntry.edgeChanges) {
      switch (edgeChange.action) {
        case ChangeAction.create:
          addEdges.push({ ...edgeChange.edge, color: this.changedEdgeColor });
          break;
        case ChangeAction.delete:
          deleteEdgeIds.push(edgeChange.edge.id as string);
          break;
        default:
      }
    }

    return { addNodes, updateNodes, deleteNodeIds, addEdges, deleteEdgeIds };
  }

  private createChangelogEntry(variables: PanelViewInputVariableMap): VisjsChangelogEntry {
    const addedVariableIds = Array.from(variables.keys()).filter((id: string) => !this.currentPanelViewVariables?.has(id));
    const deletedVariableIds = Array.from(this.currentPanelViewVariables?.keys() || []).filter((id: string) => !variables.has(id));
    const updatedVariableIds = Array.from(this.currentPanelViewVariables?.keys() || []).filter((id: string) =>
      this.variableChanged(this.currentPanelViewVariables?.get(id), variables.get(id))
    );

    const [newNodes, newEdges] = this.buildCreateChangelogEntry(addedVariableIds, variables);
    const [deletedNodes, deletedEdges] = this.buildDeleteChangelogEntry(deletedVariableIds);
    const [updateNodes, updatedEdges] = this.buildUpdateChangelogEntry(updatedVariableIds, variables);

    // Create a Set to easily remove duplications
    const nodeChanges = new Set([...newNodes, ...deletedNodes, ...updateNodes]);
    const edgeChanges = new Set([...newEdges, ...deletedEdges, ...updatedEdges]);

    return { nodeChanges: [...nodeChanges], edgeChanges: [...edgeChanges] };
  }

  private buildUpdateChangelogEntry(
    updatedVariableIds: string[],
    variables: PanelViewInputVariableMap
  ): [nodes: ChangedNode[], edges: ChangedEdge[]] {
    const nodeChanges: ChangedNode[] = [];
    const edgeChanges: ChangedEdge[] = [];

    for (const variableId of updatedVariableIds) {
      const oldVariable = this.currentPanelViewVariables?.get(variableId);
      const newVariable = variables.get(variableId);
      if (oldVariable && newVariable) {
        this.addNodeAndEdgeChanges(oldVariable, newVariable, nodeChanges, edgeChanges);
      }
    }

    return [nodeChanges, edgeChanges];
  }

  private addNodeAndEdgeChanges(
    oldVariable: PanelViewVariable,
    newVariable: PanelViewVariable,
    nodeChanges: ChangedNode[],
    edgeChanges: ChangedEdge[]
  ): void {
    if (
      oldVariable.value !== newVariable.value ||
      oldVariable.tooltip !== newVariable.tooltip ||
      oldVariable.type !== newVariable.type ||
      oldVariable.name !== newVariable.name ||
      !isEqual(oldVariable.primitiveValues, newVariable.primitiveValues)
    ) {
      nodeChanges.push({
        action: ChangeAction.update,
        oldNode: this.createNode(oldVariable),
        newNode: this.createNode(newVariable),
      });
    }

    const addedIncomingRelations = (newVariable.incomingRelations || []).filter(
      (relation: VariableRelation) =>
        !some(oldVariable.incomingRelations, (rel) => rel.relationName === relation.relationName && rel.parentId === relation.parentId)
    );
    const deletedIncomingRelations = (oldVariable.incomingRelations || []).filter(
      (relation: VariableRelation) =>
        !some(newVariable.incomingRelations, (rel) => rel.relationName === relation.relationName && rel.parentId === relation.parentId)
    );

    for (const relation of addedIncomingRelations) {
      edgeChanges.push({
        action: ChangeAction.create,
        edge: {
          id: `${relation.parentId}to${newVariable.id}withName${relation.relationName}`,
          from: relation.parentId,
          to: newVariable.id,
          label: relation.relationName,
        },
      });
    }

    for (const relation of deletedIncomingRelations) {
      edgeChanges.push({
        action: ChangeAction.delete,
        edge: {
          id: `${relation.parentId}to${newVariable.id}withName${relation.relationName}`,
          from: relation.parentId,
          to: newVariable.id,
          label: relation.relationName,
        },
      });
    }
  }

  private buildCreateChangelogEntry(
    addedVariableIds: string[],
    variables: PanelViewInputVariableMap
  ): [nodes: ChangedNode[], edges: ChangedEdge[]] {
    const nodeChanges: ChangedNode[] = [];
    const edgeChanges: ChangedEdge[] = [];

    for (const variableId of addedVariableIds) {
      const variable = variables.get(variableId);
      if (variable) {
        nodeChanges.push({
          action: ChangeAction.create,
          node: this.createNode(variable),
        });

        for (const relation of variable.incomingRelations || []) {
          edgeChanges.push({
            action: ChangeAction.create,
            edge: {
              id: `${relation.parentId}to${variable.id}withName${relation.relationName}`,
              from: relation.parentId,
              to: variable.id,
              label: relation.relationName,
            },
          });
        }
      }
    }

    return [nodeChanges, edgeChanges];
  }

  private buildDeleteChangelogEntry(deletedVariableIds: string[]): [nodes: ChangedNode[], edges: ChangedEdge[]] {
    const nodeChanges: ChangedNode[] = [];
    const edgeChanges: ChangedEdge[] = [];

    for (const variableId of deletedVariableIds) {
      const variable = this.currentPanelViewVariables?.get(variableId);
      if (variable) {
        nodeChanges.push({
          action: ChangeAction.delete,
          node: this.createNode(variable),
        });

        for (const relation of variable.incomingRelations || []) {
          edgeChanges.push({
            action: ChangeAction.delete,
            edge: {
              id: `${relation.parentId}to${variable.id}withName${relation.relationName}`,
              from: relation.parentId,
              to: variable.id,
              label: relation.relationName,
            },
          });
        }
      }
    }

    return [nodeChanges, edgeChanges];
  }

  private variableChanged(v1?: PanelViewVariable, v2?: PanelViewVariable): boolean {
    return Boolean(v1) && Boolean(v2) && !isEqual(v1, v2);
  }

  private parseInputToData(variables: PanelViewInputVariableMap): Data {
    const nodes: Node[] = [];
    let edges: Edge[] = [];

    for (const variable of variables.values()) {
      nodes.push(this.createNode(variable));
      edges = [...edges, ...this.createEdges(variable)];
    }

    return { nodes, edges };
  }

  private createNode(variable: PanelViewVariable): Node {
    const hasValueAndType = variable.type && variable.name;
    const variableType = variable.type ? `(${variable.type})` : '';
    const topLine = `${variableType}${hasValueAndType ? ' ' : ''}${variable.name ? variable.name : ''}`;
    let bottomSection: string | undefined;
    if (variable.value) {
      bottomSection = variable.value;
    } else if (variable.primitiveValues && variable.primitiveValues.length > 0) {
      bottomSection = variable.primitiveValues.map((value) => `(${value.type}) ${value.name}: ${value.value}`).join('\n');
    }

    let label = '';
    if (topLine.length > 0) {
      label = topLine;
      if (bottomSection && bottomSection.length > 0) {
        label += `:\n${bottomSection}`;
      }
    } else if (bottomSection) {
      label = bottomSection;
    }

    return { id: variable.id, label, title: variable.tooltip };
  }

  private createEdges(variable: PanelViewVariable): Edge[] {
    const edges: Edge[] = [];

    for (const relation of variable.incomingRelations || []) {
      edges.push({
        id: `${relation.parentId}to${variable.id}withName${relation.relationName}`,
        from: relation.parentId,
        to: variable.id,
        label: relation.relationName,
      });
    }

    return edges;
  }
}
