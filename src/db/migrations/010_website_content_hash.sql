-- Website analysis: remember a fingerprint of the text that was read, so an unchanged site is not sent to the AI again. Additive only.
ALTER TABLE website_analyses ADD COLUMN content_hash TEXT;
