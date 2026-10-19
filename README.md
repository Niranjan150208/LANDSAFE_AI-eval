# LANDSAFE_AI — Evaluation Snapshot

This repository is a lightweight evaluation snapshot of the original project:
https://github.com/Niranjan150208/LANDSAFE_AI

Purpose
- Provide a compact package (metadata + instructions + scoring rubric) that you can feed to an AI to produce an objective project score.

Repository metadata
- Original repo: https://github.com/Niranjan150208/LANDSAFE_AI
- Language composition:
  - HTML: 71.5%
  - JavaScript: 28.4%
  - Other: 0.1%

Scoring rubric (weights)
- Functionality: 25%
- Innovation: 20%
- Technical Implementation: 20%
- UI/UX: 15%
- Feasibility: 10%
- Demo: 10%

How to use
1. Use the included `eval_instructions.json` and the `ai_prompt.txt` prompt template.
2. Provide the original repo URL and language composition to the AI along with the files (or just link the repo if the AI can access it).
3. Ask the AI to produce:
   - A numeric score 0–100 for each category.
   - A weighted overall score (0–100) using the rubric weights above.
   - A short justification (1–3 short paragraphs) for each category including specific evidence (file names, paths, or code snippets where possible).
   - A final single-paragraph summary and suggested improvements prioritized by impact.

Required AI output format
- Output MUST be valid JSON with these fields:
  - scores: { functionality, innovation, technical_implementation, ui_ux, feasibility, demo } (each 0-100)
  - weighted_total: number (0-100)
  - breakdown: object with short justification strings for each category
  - evidence: array of objects { category, file_path, excerpt_or_line_reference, remark }
  - suggestions: array of short prioritized suggestions

Example (partial)
{
  "scores": {"functionality": 78, "innovation": 70, "technical_implementation": 65, "ui_ux": 80, "feasibility": 75, "demo": 60},
  "weighted_total": 73.25,
  "breakdown": {
    "functionality": "The app implements core features A and B; missing edge-case C.",
    ...
  },
  "evidence": [
    {"category":"functionality","file_path":"src/app.html","excerpt_or_line_reference":"index.html#L10-L24","remark":"Contains homepage and links to demo"}
  ],
  "suggestions": ["Add server-side validation to fix edge-case C", "Provide a runnable demo script"]
}

If you want me to commit these files into the LANDSAFE_AI-eval repository, say "Push files" and I will add them to the repo. If you'd like a full duplicate of the original repo instead, say "Full duplicate" and I will copy all files into a new repo (or overwrite if you prefer).
