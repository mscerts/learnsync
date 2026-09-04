import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenTaxonomy, normalizeUrl } from "../scripts/lib/learn-helpers.mjs";

test("flattenTaxonomy maps top-level and child ids to names and top-level parents", () => {
  const { nameById, topIdById } = flattenTaxonomy([
    { id: "azure", name: "Azure", children: [{ id: "azure-cosmos-db", name: "Azure Cosmos DB" }] },
    { id: "github", name: "GitHub" },
  ]);
  assert.equal(nameById.get("azure"), "Azure");
  assert.equal(nameById.get("azure-cosmos-db"), "Azure Cosmos DB");
  assert.equal(nameById.get("github"), "GitHub");
  assert.equal(topIdById.get("azure"), "azure");
  assert.equal(topIdById.get("azure-cosmos-db"), "azure");
  assert.equal(topIdById.get("nonexistent"), undefined);
});

test("flattenTaxonomy tolerates entries without children", () => {
  const { nameById } = flattenTaxonomy([{ id: "solo", name: "Solo" }]);
  assert.equal(nameById.size, 1);
});

test("normalizeUrl strips /en-us/ and rewrites WT.mc_id", () => {
  assert.equal(
    normalizeUrl("https://learn.microsoft.com/en-us/training/modules/intro/?WT.mc_id=api_CatalogApi"),
    "https://learn.microsoft.com/training/modules/intro/?WT.mc_id=studentamb_165290"
  );
  assert.equal(
    normalizeUrl("https://learn.microsoft.com/training/modules/intro/"),
    "https://learn.microsoft.com/training/modules/intro/"
  );
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl(undefined), undefined);
});
