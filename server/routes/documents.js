// Documents + collections REST API (local PageIndex + LlamaIndex).
// Ingests PDF, Markdown, text, URL, DOCX, XLSX, PPTX, CSV, HTML. Indexes
// via PageIndex through LlamaIndex.TS framework with SQLite persistence.
// Status transitions broadcast as documents_status WS events.

export function registerDocumentRoutes(ctx) {
  const { app, db, documents, collections, upload } = ctx;

  app.post("/api/documents", upload.single("file"), async (req, res) => {
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
    }
    try {
      const { id, name, type } = req.body;
      if (!req.file && !type) {
        return res.status(400).json({ error: "Missing file or type" });
      }

      const result = await documents.addDocument({
        id,
        name: req.file ? req.file.originalname : name,
        type: req.file ? documents.typeForFilename(req.file.originalname) : type,
        buffer: req.file?.buffer,
        content: req.body.content,
        url: req.body.url,
      });

      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get("/api/documents", (_req, res) => {
    res.json({ documents: documents.listDocuments() });
  });

  app.get("/api/documents/:id", async (req, res) => {
    try {
      const content = await documents.getDocumentContent(req.params.id);
      if (content === null) return res.status(404).json({ error: "Not found" });
      res.json({ content });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    const removed = await documents.removeDocument(req.params.id);
    res.status(removed ? 200 : 404).json({ removed });
  });

  app.post("/api/documents/query", async (req, res) => {
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing query" });
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
    }
    try {
      const result = await documents.queryCollection(query);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── Collections REST API routes (named document groups) ───────────────────
  // Collections allow organizing documents into named groups for scoped querying.

  app.get("/api/collections", (_req, res) => {
    res.json({ collections: collections.listCollections() });
  });

  app.post("/api/collections", async (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });
    try {
      const collection = await collections.createCollection({ name, description });
      res.json(collection);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.patch("/api/collections/:id", async (req, res) => {
    const { name, description } = req.body;
    try {
      const collection = await collections.renameCollection(req.params.id, { name, description });
      res.json(collection);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/collections/:id", async (req, res) => {
    await collections.deleteCollection(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/collections/:id/documents", async (req, res) => {
    try {
      const docs = await collections.listCollectionDocuments(req.params.id);
      res.json({ documents: docs });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post("/api/collections/:id/documents", async (req, res) => {
    const { documentId } = req.body;
    if (!documentId) return res.status(400).json({ error: "Missing documentId" });
    try {
      await collections.addDocumentToCollection(req.params.id, documentId);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.delete("/api/collections/:id/documents/:documentId", async (req, res) => {
    await collections.removeDocumentFromCollection(req.params.id, req.params.documentId);
    res.json({ ok: true });
  });

  app.post("/api/collections/:id/query", async (req, res) => {
    const query = (req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing query" });
    if (!db.isDbReady()) {
      return res.status(503).json({ error: "Document collection is disabled (database unavailable)" });
    }
    try {
      const result = await collections.queryCollection(req.params.id, query);
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}
