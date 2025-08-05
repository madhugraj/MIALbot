import Chatbot from "@/components/Chatbot";

const Index = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-indigo-900 via-slate-900 to-purple-900 p-4">
      <div className="flex-grow flex items-center justify-center w-full">
        <Chatbot />
      </div>
    </div>
  );
};

export default Index;