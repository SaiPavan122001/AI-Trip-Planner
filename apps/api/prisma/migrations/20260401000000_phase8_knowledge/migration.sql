-- Phase 8: the knowledge index (documents and their searchable chunks).
-- Additive only: two new tables, nothing existing is touched.

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "rowId" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "reference" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "authority" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "reviewBy" TEXT,
    "topic" TEXT,
    "destination" TEXT,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quarantineReasons" JSONB NOT NULL DEFAULT '[]',
    "chunkCount" INTEGER NOT NULL,
    "previousVersions" JSONB NOT NULL DEFAULT '[]',
    "embeddingSpace" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("rowId")
);

-- CreateTable
CREATE TABLE "knowledge_chunks" (
    "namespace" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "docRowId" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "heading" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "startChar" INTEGER NOT NULL,
    "endChar" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "space" TEXT NOT NULL,
    "vector" BYTEA NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "reference" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "authority" INTEGER NOT NULL,
    "effectiveDate" TEXT NOT NULL,
    "reviewBy" TEXT,
    "topic" TEXT,
    "destination" TEXT,

    CONSTRAINT "knowledge_chunks_pkey" PRIMARY KEY ("namespace","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_namespace_docId_version_contentHash_key" ON "knowledge_documents"("namespace", "docId", "version", "contentHash");

-- CreateIndex
CREATE INDEX "knowledge_documents_namespace_status_idx" ON "knowledge_documents"("namespace", "status");

-- CreateIndex
CREATE INDEX "knowledge_documents_namespace_contentHash_idx" ON "knowledge_documents"("namespace", "contentHash");

-- CreateIndex
CREATE INDEX "knowledge_chunks_namespace_space_idx" ON "knowledge_chunks"("namespace", "space");

-- CreateIndex
CREATE INDEX "knowledge_chunks_docRowId_idx" ON "knowledge_chunks"("docRowId");

-- A document has at most one active version per namespace: the database enforces it.
-- (Prisma cannot express a partial index, so it lives here only.)
CREATE UNIQUE INDEX "knowledge_documents_one_active" ON "knowledge_documents"("namespace", "docId") WHERE "status" = 'active';

-- AddForeignKey
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_docRowId_fkey" FOREIGN KEY ("docRowId") REFERENCES "knowledge_documents"("rowId") ON DELETE CASCADE ON UPDATE CASCADE;
