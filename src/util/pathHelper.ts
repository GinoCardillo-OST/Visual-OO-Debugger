import { ExtensionContext, Uri, Webview } from 'vscode';

interface PathReplacement {
  tag: string;
  uri: Uri;
}

export class PathHelper {
  private readonly extensionUri: Uri;

  private static getFileName(fileNameStub: string, extension: string): string {
    return `${fileNameStub}.${extension}`;
  }

  constructor(private readonly webview: Webview, extensionContext: ExtensionContext) {
    this.extensionUri = extensionContext.extensionUri;
  }

  createMediaReplacement(extension: string, fileNameStub: string): PathReplacement {
    return {
      tag: PathHelper.getFileName(fileNameStub, extension),
      uri: this.getMediaUri(extension, fileNameStub),
    };
  }

  getMediaUri(extension: string, fileNameStub: string): Uri {
    return this.getUri('media', extension, PathHelper.getFileName(fileNameStub, extension));
  }

  getUri(...pathSegments: string[]): Uri {
    return this.webview.asWebviewUri(Uri.joinPath(this.extensionUri, ...pathSegments));
  }
}
