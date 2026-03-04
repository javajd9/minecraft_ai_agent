import os
import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    TrainingArguments,
    pipeline,
)
from peft import LoraConfig, prepare_model_for_kbit_training, get_peft_model
from trl import SFTTrainer
import argparse

def train(epochs=3, batch_size=4, model_id="unsloth/Llama-3.2-3B-Instruct"):
    print(f"🚀 Starting fine-tuning on {model_id}...")

    # 1. Load Dataset
    data_path = os.path.join(os.path.dirname(__file__), "training_data.jsonl")
    if not os.path.exists(data_path):
        print(f"❌ Error: {data_path} not found. Run prepare_data.js first.")
        return

    dataset = load_dataset("json", data_files=data_path, split="train")
    
    # Preprocess: Combine instruction and output into a single string for training
    def format_prompt(sample):
        return f"### Instruction:\n{sample['instruction']}\n\n### Response:\n{sample['output']}"

    # 2. BitsAndBytes Config (4-bit quantization)
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
    )

    # 3. Load Model and Tokenizer
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        quantization_config=bnb_config,
        device_map="auto",
        trust_remote_code=True
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, trust_remote_code=True)
    tokenizer.pad_token = tokenizer.eos_token

    # 4. Prepare for LoRA
    model = prepare_model_for_kbit_training(model)
    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, peft_config)

    # 5. Training Arguments
    output_dir = os.path.join(os.path.dirname(__file__), "lora_adapter")
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        gradient_accumulation_steps=4,
        optim="paged_adamw_32bit",
        save_steps=100,
        logging_steps=10,
        learning_rate=2e-4,
        weight_decay=0.001,
        fp16=True,
        max_grad_norm=0.3,
        warmup_ratio=0.03,
        group_by_length=True,
        lr_scheduler_type="constant",
        report_to="none"
    )

    # 6. SFT Trainer
    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        peft_config=peft_config,
        formatting_func=format_prompt,
        max_seq_length=1024,
        tokenizer=tokenizer,
        args=training_args,
    )

    # 7. Train!
    trainer.train()
    
    # 8. Save
    trainer.save_model(output_dir)
    print(f"✅ Training complete! Adapter saved to {output_dir}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test", action="store_true", help="Run a quick smoke test")
    args = parser.parse_args()
    
    if args.test:
        train(epochs=1, batch_size=1)
    else:
        train()
