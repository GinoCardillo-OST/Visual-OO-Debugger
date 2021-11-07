import { PanelViewInput } from '../../model/panelViewInput';

export interface PanelViewProxy {
  getHtml: () => string;
  updatePanel: (panelViewInput: PanelViewInput) => PanelViewCommand;
  exportPanel: () => PanelViewCommand;
  startRecordingPanel: () => PanelViewCommand;
  stopRecordingPanel: () => PanelViewCommand;
  teardownPanelView: () => void;
}

export interface PanelViewCommand {
  [key: string]: unknown;
  command: string;
}
