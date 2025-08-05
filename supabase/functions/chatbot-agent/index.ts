import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Helper to call the Gemini API
async function callGemini(apiKey, prompt) {
  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!geminiResponse.ok) {
    const errorText = await geminiResponse.text();
    console.error(`Gemini API error: ${geminiResponse.status} - ${errorText}`);
    throw new Error(`Failed to get response from Gemini API: ${geminiResponse.statusText}`);
  }

  const geminiData = await geminiResponse.json();
  if (geminiData.candidates && geminiData.candidates[0].content && geminiData.candidates[0].content.parts) {
    return geminiData.candidates[0].content.parts[0].text;
  }
  
  throw new Error("Gemini response did not contain expected content structure.");
}

// Helper to format history
function formatHistory(history) {
    if (!history || history.length === 0) return "No conversation history yet.";
    return history.map(msg => `${msg.sender === 'user' ? 'User' : 'Assistant'}: ${msg.text}`).join('\n');
}

// Tool 1: Flight Query Logic
async function handleFlightQuery(supabase: SupabaseClient, geminiApiKey: string, user_query: string, formattedHistory: string) {
  console.log("Inside handleFlightQuery");
  
  const parameterExtractionPrompt = `You are an AI assistant that extracts flight query parameters from a user's message.
The current date is ${new Date().toDateString()}.
Based on the conversation history and the user's latest message, extract the following parameters:
- airline_code (e.g., "BA", "AA")
- flight_number (e.g., "2490", "123")
- origin_date (in YYYY-MM-DD format)

Return a JSON object with the extracted parameters. If a parameter is not found, omit it.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"

**JSON Output:**`;

  const parameterText = await callGemini(geminiApiKey, parameterExtractionPrompt);
  let parameters = {};
  try {
    parameters = JSON.parse(parameterText.replace(/```json\n|```/g, '').trim());
  } catch (e) {
    console.error("Failed to parse parameters JSON:", parameterText, e);
    return { response: "I'm sorry, I had trouble understanding the details of your request. Could you please be more specific?", suggestions: [] };
  }
  
  const { data, error } = await supabase.rpc('get_flight_info', {
      p_airline_code: parameters.airline_code,
      p_flight_number: parameters.flight_number,
      p_origin_date: parameters.origin_date
  });

  if (error) {
    console.error('Database Function Error:', error);
    return { response: `I'm sorry, I ran into a problem trying to find that information. Please try rephrasing your question.`, suggestions: [] };
  }

  if (data && Array.isArray(data) && data.length > 0) {
    const summarizationPrompt = `You are Mia, a helpful flight assistant. Your task is to provide a clear and direct answer to the user's question based on the database results and conversation history.

**Conversation History:**
${formattedHistory}
**User's Latest Question:** "${user_query}"
**Database Results (JSON):**
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
**Your Answer:**`;
    
    const summary = await callGemini(geminiApiKey, summarizationPrompt);

    const { data: schemaData } = await supabase.from('schema_metadata').select('schema_json').eq('table_name', 'flight_schedule').single();
    const schema_definition = schemaData ? (schemaData.schema_json.schema || schemaData.schema_json) : 'Not available';

    const suggestionGenerationPrompt = `You are an expert AI assistant that generates relevant follow-up questions for a user inquiring about flight information. Your suggestions MUST be answerable using ONLY the provided database schema.

**Database Schema for 'flight_schedule' table:**
${JSON.stringify(schema_definition, null, 2)}

**Conversation Context:**
*   **History:** ${formattedHistory}
*   **User's Latest Question:** "${user_query}"
*   **Your Last Answer:** "${summary}"
*   **Data Used for Answer:** ${JSON.stringify(data, null, 2)}

**CRITICAL INSTRUCTIONS:**
1.  **Schema-Bound:** Generate questions that can be answered using the columns in the schema above (e.g., \`gate_name\`, \`terminal_name\`, \`arrival_airport_name\`, \`delay_duration\`).
2.  **Avoid Unanswerable Questions:** DO NOT suggest questions about topics not covered by the schema.
3.  **Contextual & Relevant:** The questions should be a natural continuation of the conversation and focus on details NOT already provided in "Your Last Answer".
4.  **Format:** Return a JSON array of 3-4 short, to-the-point questions. Example: \`["What's the arrival time?", "Which gate is it at?"]\`
5.  **Empty Array on Failure:** If no relevant, answerable suggestions come to mind, return an empty array \`[]\`.
6.  **No Markdown:** Do not include markdown like \`\`\`json.

**Follow-up Suggestions (JSON Array):**`;

    const suggestionsText = await callGemini(geminiApiKey, suggestionGenerationPrompt);
    let suggestions = [];
    try {
        suggestions = JSON.parse(suggestionsText.trim());
    } catch (e) {
        console.error("Failed to parse suggestions JSON:", suggestionsText, e);
        suggestions = [];
    }

    return { response: summary, suggestions };
  }

  const notFoundResponse = `I'm sorry, but I couldn't find any information for that query. Please check the flight details and try again.`;
  return { response: notFoundResponse, suggestions: [] };
}

// Tool 2: General Conversation Logic
async function handleGeneralConversation(geminiApiKey: string, user_query: string, formattedHistory: string) {
  console.log("Inside handleGeneralConversation");
  const prompt = `You are Mia, a friendly and helpful AI assistant for Miami International Airport.
Respond to the user's latest message in a brief, helpful, and conversational way, using the history for context.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Your Response:**`;
  const response = await callGemini(geminiApiKey, prompt);
  
  return { response, suggestions: [] };
}

// Main Server Logic (The Agent/Router)
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query, history } = await req.json();
    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) throw new Error('GEMINI_API_KEY is not set.');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );
    
    const formattedHistory = formatHistory(history);

    const intentClassificationPrompt = `You are a router agent. Your job is to classify the user's latest intent.
Respond with one of the following tool names:
- 'FLIGHT_QUERY': If the user is asking about flights, delays, terminals, gates, airlines, or a short follow-up question related to a previous flight query.
- 'GENERAL_CONVERSATION': If the user is making small talk, greeting, or asking a question not related to flights.

**Conversation History:**
${formattedHistory}
**User's Latest Message:** "${user_query}"
**Tool:**`;

    const rawIntent = await callGemini(geminiApiKey, intentClassificationPrompt);
    const intent = rawIntent.trim().toUpperCase().replace(/['".]/g, "");
    console.log("Cleaned Intent:", intent);

    let result;

    if (intent.includes('FLIGHT_QUERY')) {
      console.log("Routing to FLIGHT_QUERY tool.");
      result = await handleFlightQuery(supabase, geminiApiKey, user_query, formattedHistory);
    } else {
      console.log("Routing to GENERAL_CONVERSATION tool.");
      result = await handleGeneralConversation(geminiApiKey, user_query, formattedHistory);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Edge Function Catch Block Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});