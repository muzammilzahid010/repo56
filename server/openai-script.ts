/**
 * Generate script/storyboard using ChatGPT API
 * Simple GET-based API that returns plain text
 */
export async function generateScript(
  storyAbout: string,
  numberOfPrompts: number,
  finalStep: string
): Promise<string> {
  const MAX_RETRIES = 3;
  const TIMEOUT_MS = 120000; // 120 seconds

  const prompt = `Write a storyboard for an animated film about a ${storyAbout}, consisting of ${numberOfPrompts} steps. Each step should include an English prompt. The final step should ${finalStep}. Describe the animated character fully in English at the beginning, and repeat that full character description in each prompt (do not use pronouns or shorthand such as "the same character"). The purpose is to reinforce the character's identity in every scene.

CRITICAL FORMATTING REQUIREMENTS:
1. Output ONLY the scene descriptions (no labels, no numbering, no step numbers, no titles)
2. Separate EACH scene with a blank line (press enter twice between scenes)
3. Each scene should be a single detailed paragraph
4. Example format:

The brave knight, standing tall in polished armor, wakes at dawn in the castle courtyard...

The brave knight, standing tall in polished armor, mounts his black horse and rides through the misty forest...

The brave knight, standing tall in polished armor, confronts the dragon at the mountain peak...`;

  let lastError = "";
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[Script Generator] Attempt ${attempt}/${MAX_RETRIES}`);

      // Create abort controller for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        // URL encode the prompt for the query parameter
        const encodedPrompt = encodeURIComponent(prompt);
        const apiUrl = `https://chat-gpt.fak-official.workers.dev/?q=${encodedPrompt}`;
        
        const response = await fetch(apiUrl, {
          method: 'GET',
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        // This API returns plain text directly
        const storyboard = await response.text();
        
        if (!storyboard || typeof storyboard !== 'string') {
          throw new Error("API response is empty or invalid");
        }

        const trimmedStoryboard = storyboard.trim();

        if (trimmedStoryboard.length < 50) {
          throw new Error("Generated script is too short, likely incomplete");
        }

        console.log(`[Script Generator] Success on attempt ${attempt}`);
        return trimmedStoryboard;

      } catch (fetchError) {
        clearTimeout(timeoutId);
        
        // If it's an abort error (timeout), throw to retry
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          throw new Error(`Request timeout after ${TIMEOUT_MS}ms`);
        }
        
        throw fetchError;
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      lastError = errorMessage;
      console.error(`[Script Generator] Attempt ${attempt} failed:`, errorMessage);
      
      if (attempt < MAX_RETRIES) {
        // Wait before retrying (short delay)
        const waitMs = 2000;
        console.log(`[Script Generator] Waiting ${waitMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }
  
  // All attempts failed
  throw new Error(`Failed to generate script after ${MAX_RETRIES} attempts. Last error: ${lastError}`);
}
