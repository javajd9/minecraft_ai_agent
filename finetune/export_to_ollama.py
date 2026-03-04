import os
import subprocess

def export_to_ollama():
    print("📦 Exporting fine-tuned model to Ollama...")
    
    adapter_path = os.path.join(os.path.dirname(__file__), "lora_adapter")
    if not os.path.exists(adapter_path):
        print(f"❌ Error: Adapter path {adapter_path} not found. Run train_lora.py first.")
        return

    # Note: For simple local use with Ollama, the easiest path is often to use the adapter directly 
    # if Ollama supports it, or merge and export to GGUF.
    # Here we'll create a Modelfile that refers to the base model + adapter if possible, 
    # or instructions on how to merge.
    
    modelfile_content = f"""
FROM llama3.2
ADAPTER {adapter_path}
PARAMETER temperature 0.7
PARAMETER num_predict 500
SYSTEM You are DIDDYBOT, a Minecraft survival agent.
"""
    
    modelfile_path = os.path.join(os.path.dirname(__file__), "Modelfile")
    with open(modelfile_path, "w") as f:
        f.write(modelfile_content)
        
    print(f"📝 Created Modelfile at {modelfile_path}")
    print("🚀 Registering with Ollama...")
    
    try:
        subprocess.run(["ollama", "create", "diddybot-tuned", "-f", modelfile_path], check=True)
        print("✅ Model 'diddybot-tuned' created successfully!")
    except Exception as e:
        print(f"❌ Error creating model in Ollama: {e}")
        print("Manual step: Run 'ollama create diddybot-tuned -f finetune/Modelfile'")

if __name__ == "__main__":
    export_to_ollama()
