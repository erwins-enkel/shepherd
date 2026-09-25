use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    let mut io = shepherd_cli::Io::system();
    let code = shepherd_cli::run(std::env::args_os(), &mut io).await;
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
