export interface AudioFileStt {
  transcribeFile(audio: Buffer, opts: { filename: string; contentType: string }): Promise<string>;
}
