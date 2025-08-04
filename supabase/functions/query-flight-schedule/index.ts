import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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
  console.log("Raw Gemini Response:", JSON.stringify(geminiData, null, 2));

  if (geminiData.candidates && geminiData.candidates.length > 0 && geminiData.candidates[0].content && geminiData.candidates[0].content.parts && geminiData.candidates[0].content.parts.length > 0) {
    return geminiData.candidates[0].content.parts[0].text;
  }
  
  throw new Error("Gemini response did not contain expected content structure.");
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query } = await req.json();
    console.log("User Query:", user_query);

    const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiApiKey) {
      throw new Error('GEMINI_API_KEY is not set in Supabase secrets.');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    );

    const { data: schemaData, error: schemaError } = await supabase
      .from('schema_metadata')
      .select('schema_json')
      .eq('table_name', 'flight_schedule')
      .single();

    if (schemaError || !schemaData) {
      console.error('Error fetching schema metadata:', schemaError);
      throw new Error('Failed to retrieve table schema from database.');
    }

    const sqlGenerationPrompt = `You are an expert PostgreSQL assistant. Your task is to generate a single, read-only \`SELECT\` query to answer a user's question about flight schedules.
You are given the table schema for 'flight_schedule':
\`\`\`json
${JSON.stringify(schemaData.schema_json, null, 2)}
\`\`\`
- ALWAYS generate a valid \`SELECT\` query.
- For questions about counts, use \`SELECT COUNT(*) as count FROM ...\`.
- For questions about specific flights, select relevant columns. Avoid \`SELECT *\`.
- If the user's request is ambiguous or cannot be answered with a \`SELECT\` query on this table, return the text "INVALID_QUERY".

User request: "${user_query}"

Generated SQL Query:`;

    const generatedText = await callGemini(geminiApiKey, sqlGenerationPrompt);
    console.log("Generated Text from Gemini:", generatedText);

    let sqlQuery;
    const sqlMatch = generatedText.match(/```sql\n([\s\S]*?)\n```/);
    if (sqlMatch && sqlMatch[1]) {
      sqlQuery = sqlMatch[1].trim();
    } else {
      sqlQuery = generatedText.trim();
    }
    console.log("Parsed SQL Query:", sqlQuery);

    let naturalLanguageResponse;

    if (sqlQuery && sqlQuery.toUpperCase() !== 'INVALID_QUERY') {
      const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

      if (error) {
        console.error('SQL Execution Error:', error);
        naturalLanguageResponse = `I'm sorry, I ran into a problem trying to find that information. The query I tried to run was invalid. Please try rephrasing your question.`;
      } else if (data && Array.isArray(data) && data.length > 0) {
        console.log("SQL Query Result Data:", JSON.stringify(data, null, 2));
        
        const summarizationPrompt = `You are a helpful flight assistant. A user asked: "${user_query}".
The following data was retrieved from the database in JSON format:
\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
Based on this data, provide a concise, natural language answer. Do not just list the data. Summarize it in a friendly and helpful way. If the data contains a count, state it clearly.`;
        
        naturalLanguageResponse = await callGemini(geminiApiKey, summarizationPrompt);
      } else {
        naturalLanguageResponse = "I couldn't find any data matching your query.";
      }
    } else {
      naturalLanguageResponse = "I couldn't generate a SQL query for that request. Please try rephrasing your question or ask about flight schedules, delays, or counts.";
    }

    return new Response(JSON.stringify({ response: naturalLanguageResponse }), {
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