"use client";

import React from 'react';
import { Button } from '@/components/ui/button';

const questions = [
  "What is the status of flight ",
  "What are the terminal details for flight ",
  "Is flight ",
  "Which gate is flight "
];

interface PredefinedQuestionsProps {
  onQuestionSelect: (question: string) => void;
}

const PredefinedQuestions: React.FC<PredefinedQuestionsProps> = ({ onQuestionSelect }) => {
  return (
    <div className="px-6 pb-4 border-t border-gray-200/80">
      <p className="text-xs text-center text-gray-500 pt-3 mb-2">Or get started with a question:</p>
      <div className="grid grid-cols-2 gap-2">
        {questions.map((q, index) => (
          <Button 
            key={index} 
            variant="outline" 
            className="text-xs h-auto py-2 px-3 whitespace-normal text-left justify-start font-normal bg-white/50 hover:bg-white/90 text-gray-700"
            onClick={() => onQuestionSelect(q)}
          >
            {q}...
          </Button>
        ))}
      </div>
    </div>
  );
};

export default PredefinedQuestions;