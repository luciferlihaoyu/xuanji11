ALTER TABLE `document_chunks` ADD `charStart` integer;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `charEnd` integer;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `pageStart` integer;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `pageEnd` integer;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `sectionPath` text;--> statement-breakpoint
ALTER TABLE `document_chunks` ADD `contentHash` text;--> statement-breakpoint
CREATE INDEX `documentChunks_doc_page_idx` ON `document_chunks` (`documentId`,`pageStart`);--> statement-breakpoint
CREATE INDEX `documentChunks_doc_hash_idx` ON `document_chunks` (`documentId`,`contentHash`);--> statement-breakpoint
ALTER TABLE `knowledge_edges` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `knowledge_edges` ADD `evidenceDocumentId` integer;--> statement-breakpoint
ALTER TABLE `knowledge_edges` ADD `evidenceChunkId` integer;--> statement-breakpoint
CREATE INDEX `knowledgeEdges_evidenceChunk_idx` ON `knowledge_edges` (`evidenceChunkId`);