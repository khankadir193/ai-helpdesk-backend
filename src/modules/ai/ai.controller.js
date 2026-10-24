export const askAI = async (req, res) => {
  try {
    const {
      query,
    } = req.body;

    const generatedResponse = await aiService.generateResponse(query);
    const generatedHTML = await aiService.generateHTML(generatedResponse);

    res.status(200).json({
      html: generatedHTML,
      rawResponse: generatedResponse,
    });
  } catch (error) {
    console.error("Error in askAI controller:", error);
    res.status(500).json({
      error: error.message || "Failed to generate response from AI",
    });
  }
};
